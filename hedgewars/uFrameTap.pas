(*
 * Hedgewars, a free turn based strategy game
 * Copyright (c) 2004-2015 Andrey Korotaev <unC0Rr@gmail.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; version 2 of the License
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *)

{$INCLUDE "options.inc"}

(*
 * Sends the rendered frames and the mixed audio of a running game to a local
 * consumer (an encoder listening on two tcp ports), so that a game can be
 * streamed without capturing a screen.
 *
 * Video: every frame is read back from the back buffer just before it is
 * swapped and written as raw BGRA, bottom row first (the order OpenGL uses).
 * Audio: the output of the mixer is written as it is, signed 16 bit
 * little endian stereo at 44100 Hz. It goes through a buffer and a thread of
 * its own, so that a consumer that stops reading can never hold up the mixer
 * (and with it the game); what does not fit is dropped.
 *
 * Reading a frame back normally makes the game wait until the graphics card
 * has finished drawing it and copied it over, and then wait again while the
 * consumer takes it. HW_TAP_MODE (environment) chooses how that is done:
 *   0  plain glReadPixels and a blocking send, the original behaviour
 *   1  the read goes into a pixel buffer object and is collected a few frames
 *      later, so the graphics card copies while the game goes on
 *   2  as 1, but a thread of its own sends the frame straight from the mapped
 *      buffer, and a frame is dropped when the consumer is behind instead of
 *      holding the game up (default)
 * Modes 1 and 2 need OpenGL 2.1 and fall back to 0 without it.
 * HW_TAP_STATS=1 logs the time spent per frame every few hundred frames.
 * HW_TAP_FORMAT=nv12 converts the frames to NV12 on the graphics card first (a
 * third of the data, top row first); the default sends BGRA, bottom row first.
 * NV12 needs OpenGL 2.0 shaders and a screen size divisible by four, and the
 * tap stops without them.
 *)

unit uFrameTap;
interface

procedure TapFrame;
procedure InitAudioTap;
procedure freeModule;

implementation
uses SysUtils, uVariables, uConsts, GLunit, SDLh, uConsole, uUtils;

const
    GL_BGRA_FORMAT = $80E1;
    // pixel buffer objects (OpenGL 2.1)
    PBO_PACK_BUFFER = $88EB;
    PBO_STREAM_READ = $88E1;
    PBO_READ_ONLY = $88B8;
    connectTimeout = 10000; // the encoder starts listening just before the engine
    // an encoder reads a little of an input before it listens on the next one
    probeSize = 65536;
    // framebuffers, shaders and what they are asked for (OpenGL 2.0 and 3.0)
    FBO_FRAMEBUFFER = $8D40;
    FBO_COLOR0 = $8CE0;
    FBO_COMPLETE = $8CD5;
    FBO_BINDING = $8CA6;
    SH_FRAGMENT = $8B30;
    SH_COMPILE_STATUS = $8B81;
    PROG_LINK_STATUS = $8B82;
    PROG_CURRENT = $8B8D;
    TEX_BINDING_2D = $8069;
    TEX_CLAMP_TO_EDGE = $812F;
    // frames in flight on the graphics card, and waiting to be sent
    pboCount = 6;
    // what a pixel buffer is doing in mode 2
    psIdle = 0;
    psPending = 1; // the graphics card is copying into it
    psQueued = 2; // mapped, waiting for or in the hands of the sender
    psDone = 3; // sent, still mapped
    statsFrames = 300;
    audioRingSize = 1048576; // about six seconds
    audioChunkSize = 16384;

type
    TGenBuffers = procedure(n: LongInt; buffers: PLongWord); cdecl;
    TBindBuffer = procedure(target: LongWord; buffer: LongWord); cdecl;
    TBufferData = procedure(target: LongWord; size: PtrInt; data: Pointer; usage: LongWord); cdecl;
    TMapBuffer = function(target: LongWord; access: LongWord): Pointer; cdecl;
    TUnmapBuffer = function(target: LongWord): Byte; cdecl;
    TCreateShader = function(shaderType: LongWord): LongWord; cdecl;
    TShaderSource = procedure(shader: LongWord; count: LongInt; source: PPChar; length: PLongInt); cdecl;
    TCompileShader = procedure(shader: LongWord); cdecl;
    TGetiv = procedure(obj: LongWord; pname: LongWord; params: PLongInt); cdecl;
    TGetInfoLog = procedure(obj: LongWord; maxLength: LongInt; length: PLongInt; log: PChar); cdecl;
    TCreateProgram = function: LongWord; cdecl;
    TAttachShader = procedure(prog: LongWord; shader: LongWord); cdecl;
    TLinkProgram = procedure(prog: LongWord); cdecl;
    TUseProgram = procedure(prog: LongWord); cdecl;
    TGetUniformLocation = function(prog: LongWord; name: PChar): LongInt; cdecl;
    TUniform1f = procedure(location: LongInt; value: Single); cdecl;
    TUniform1i = procedure(location: LongInt; value: LongInt); cdecl;
    TFramebufferTexture2D = procedure(target, attachment, textarget, texture: LongWord; level: LongInt); cdecl;
    TCheckFramebufferStatus = function(target: LongWord): LongWord; cdecl;

var videoSock, audioSock: PTCPSocket;
    frameBuffer: PByte;
    frameSize: LongInt;
    frameWidth, frameHeight: LongInt;
    connected, tapFailed, frameReady: boolean;
    tapMode: LongInt;
    showStats: boolean;

    glGenBuffersP: TGenBuffers;
    glBindBufferP: TBindBuffer;
    glBufferDataP: TBufferData;
    glMapBufferP: TMapBuffer;
    glUnmapBufferP: TUnmapBuffer;
    pbo: array[0..pboCount - 1] of LongWord;
    pboFrames: LongInt;

    // mode 2: the buffers handed to the sender thread
    pboState, pboAge: array[0..pboCount - 1] of LongInt;
    pboPixels: array[0..pboCount - 1] of Pointer;
    sender: PSDL_Thread;
    senderLock: PSDL_Mutex;
    queue: array[0..pboCount - 1] of LongInt;
    queueHead, queueLength: LongInt;
    senderQuit, senderFailed: boolean;

    // the mixer output on its way to the audio socket
    audioRing: PByte;
    audioHead, audioTail, audioCount: LongInt;
    audioLock: PSDL_Mutex;
    audioThread: PSDL_Thread;
    audioQuit, audioFailed: boolean;

    // NV12 conversion on the graphics card
    tapNV12: boolean;
    readWidth, readHeight: LongInt;
    readFormat: LongWord;
    convProgram, convTexture, convFramebuffer: LongWord;
    glCreateShaderP: TCreateShader;
    glShaderSourceP: TShaderSource;
    glCompileShaderP: TCompileShader;
    glGetShaderivP, glGetProgramivP: TGetiv;
    glGetShaderInfoLogP: TGetInfoLog;
    glCreateProgramP: TCreateProgram;
    glAttachShaderP: TAttachShader;
    glLinkProgramP: TLinkProgram;
    glUseProgramP: TUseProgram;
    glGetUniformLocationP: TGetUniformLocation;
    glUniform1fP: TUniform1f;
    glUniform1iP: TUniform1i;
    glGenFramebuffersP: TGenBuffers;
    glBindFramebufferP: TBindBuffer;
    glFramebufferTexture2DP: TFramebufferTexture2D;
    glCheckFramebufferStatusP: TCheckFramebufferStatus;
    savedViewport: array[0..3] of LongInt;
    savedTexture, savedFramebuffer, savedProgram, savedMatrixMode: LongInt;
    savedCaps: array[0..8] of boolean;

    perfFreq: QWord;
    statFrames, statDropped: LongInt;
    statRead, statMap, statSend: QWord;
    statStart: QWord;

function OpenSocket(port: LongInt): PTCPSocket;
var ipaddr: TIPAddress;
    startTime: LongWord;
begin
    OpenSocket:= nil;
    if SDLNet_ResolveHost(ipaddr, PChar('127.0.0.1'), port) <> 0 then
        exit;

    startTime:= SDL_GetTicks();
    repeat
        OpenSocket:= SDLNet_TCP_Open(ipaddr);
        if OpenSocket <> nil then
            exit;
        SDL_Delay(100)
    until SDL_GetTicks() - startTime > connectTimeout
end;

// The encoder listens on the audio port first and on the video port once it
// has read some audio, so both are opened together, audio first, and the
// audio gets a little silence to read.
procedure Connect;
var silence: PByte;
begin
    if connected then
        exit;
    connected:= true;

    if cStreamAudioPort <> 0 then
        begin
        WriteToConsole('Audio tap: connecting to port ' + IntToStr(cStreamAudioPort) + ' ');
        audioSock:= OpenSocket(cStreamAudioPort);
        if audioSock = nil then
            WriteLnToConsole(msgFailed)
        else
            begin
            WriteLnToConsole(msgOK);
            GetMem(silence, probeSize);
            FillChar(silence^, probeSize, 0);
            SDLNet_TCP_Send(audioSock, silence, probeSize);
            FreeMem(silence)
            end
        end;

    if cStreamVideoPort <> 0 then
        begin
        WriteToConsole('Frame tap: connecting to port ' + IntToStr(cStreamVideoPort) + ' ');
        videoSock:= OpenSocket(cStreamVideoPort);
        if videoSock = nil then
            WriteLnToConsole(msgFailed)
        else
            WriteLnToConsole(msgOK)
        end
end;

function Micros(ticks: QWord): LongInt;
begin
    Micros:= LongInt((ticks * 1000000) div perfFreq)
end;

// the pixel buffer functions are looked up by hand: the engine's own OpenGL
// declarations stop at version 1.1 unless it is built with shaders
function LoadBufferFunctions: boolean;
var version: PChar;
begin
    LoadBufferFunctions:= false;
    version:= PChar(glGetString(GL_VERSION));
    if version = nil then
        exit;
    if (Ord(version[0]) - 48 < 2) or ((Ord(version[0]) - 48 = 2) and (Ord(version[2]) - 48 < 1)) then
        exit;

    glGenBuffersP:= TGenBuffers(SDL_GL_GetProcAddress('glGenBuffers'));
    glBindBufferP:= TBindBuffer(SDL_GL_GetProcAddress('glBindBuffer'));
    glBufferDataP:= TBufferData(SDL_GL_GetProcAddress('glBufferData'));
    glMapBufferP:= TMapBuffer(SDL_GL_GetProcAddress('glMapBuffer'));
    glUnmapBufferP:= TUnmapBuffer(SDL_GL_GetProcAddress('glUnmapBuffer'));

    LoadBufferFunctions:= (glGenBuffersP <> nil)
        and (glBindBufferP <> nil) and (glBufferDataP <> nil)
        and (glMapBufferP <> nil) and (glUnmapBufferP <> nil)
end;

// The frame as NV12 (a plane of luma, then a plane of interleaved blue and red
// differences at half the size, top row first, BT.709 limited range): a third
// of the bytes of BGRA and what encoders take as it is. A fragment shader
// writes it into a small texture four bytes to a texel, which is then read
// back like any other frame.
const
    convSource: AnsiString =
        '#version 120' + #10 +
        'uniform sampler2D tex;' + #10 +
        'uniform float w;' + #10 +
        'uniform float h;' + #10 +
        'float luma(float x, float y) {' + #10 +
        '    vec3 c = texture2D(tex, vec2((x + 0.5) / w, (h - y - 0.5) / h)).rgb;' + #10 +
        '    return 16.0 + dot(c, vec3(46.559, 156.629, 15.812));' + #10 +
        '}' + #10 +
        'float byteAt(float o) {' + #10 +
        '    if (o < w * h) {' + #10 +
        '        float row = floor((o + 0.5) / w);' + #10 +
        '        return luma(o - row * w, row);' + #10 +
        '    }' + #10 +
        '    float i = o - w * h;' + #10 +
        '    float j = floor(i * 0.5);' + #10 +
        '    float cy = floor((j + 0.5) / (w * 0.5));' + #10 +
        '    float cx = j - cy * (w * 0.5);' + #10 +
        '    vec3 c = texture2D(tex, vec2((2.0 * cx + 1.0) / w, (h - 1.0 - 2.0 * cy) / h)).rgb;' + #10 +
        '    if (mod(i, 2.0) < 0.5)' + #10 +
        '        return 128.0 + dot(c, vec3(-25.664, -86.336, 112.0));' + #10 +
        '    return 128.0 + dot(c, vec3(112.0, -101.730, -10.270));' + #10 +
        '}' + #10 +
        'void main() {' + #10 +
        '    float o = (floor(gl_FragCoord.y) * (w * 0.25) + floor(gl_FragCoord.x)) * 4.0;' + #10 +
        '    vec4 v = vec4(byteAt(o), byteAt(o + 1.0), byteAt(o + 2.0), byteAt(o + 3.0));' + #10 +
        '    gl_FragColor = floor(clamp(v, 0.0, 255.0) + 0.5) / 255.0;' + #10 +
        '}' + #10;

    convCaps: array[0..8] of LongWord = (GL_BLEND, GL_DEPTH_TEST, GL_SCISSOR_TEST,
        GL_STENCIL_TEST, GL_CULL_FACE, GL_ALPHA_TEST, GL_DITHER, GL_COLOR_LOGIC_OP,
        GL_LIGHTING);

function GetProc(core, ext: PChar): Pointer;
begin
    GetProc:= SDL_GL_GetProcAddress(core);
    if GetProc = nil then
        GetProc:= SDL_GL_GetProcAddress(ext)
end;

function BuildConversion: boolean;
var shader, target: LongWord;
    src: PChar;
    status: LongInt;
    log: array[0..511] of Char;
    version: PChar;
begin
    BuildConversion:= false;
    if frameWidth mod 4 <> 0 then
        exit;
    if frameHeight mod 4 <> 0 then
        exit;
    version:= PChar(glGetString(GL_VERSION));
    if (version = nil) or (Ord(version[0]) - 48 < 2) then
        exit;

    glCreateShaderP:= TCreateShader(SDL_GL_GetProcAddress('glCreateShader'));
    glShaderSourceP:= TShaderSource(SDL_GL_GetProcAddress('glShaderSource'));
    glCompileShaderP:= TCompileShader(SDL_GL_GetProcAddress('glCompileShader'));
    glGetShaderivP:= TGetiv(SDL_GL_GetProcAddress('glGetShaderiv'));
    glGetShaderInfoLogP:= TGetInfoLog(SDL_GL_GetProcAddress('glGetShaderInfoLog'));
    glCreateProgramP:= TCreateProgram(SDL_GL_GetProcAddress('glCreateProgram'));
    glAttachShaderP:= TAttachShader(SDL_GL_GetProcAddress('glAttachShader'));
    glLinkProgramP:= TLinkProgram(SDL_GL_GetProcAddress('glLinkProgram'));
    glGetProgramivP:= TGetiv(SDL_GL_GetProcAddress('glGetProgramiv'));
    glUseProgramP:= TUseProgram(SDL_GL_GetProcAddress('glUseProgram'));
    glGetUniformLocationP:= TGetUniformLocation(SDL_GL_GetProcAddress('glGetUniformLocation'));
    glUniform1fP:= TUniform1f(SDL_GL_GetProcAddress('glUniform1f'));
    glUniform1iP:= TUniform1i(SDL_GL_GetProcAddress('glUniform1i'));
    glGenFramebuffersP:= TGenBuffers(GetProc('glGenFramebuffers', 'glGenFramebuffersEXT'));
    glBindFramebufferP:= TBindBuffer(GetProc('glBindFramebuffer', 'glBindFramebufferEXT'));
    glFramebufferTexture2DP:= TFramebufferTexture2D(GetProc('glFramebufferTexture2D', 'glFramebufferTexture2DEXT'));
    glCheckFramebufferStatusP:= TCheckFramebufferStatus(GetProc('glCheckFramebufferStatus', 'glCheckFramebufferStatusEXT'));
    if (glCreateShaderP = nil) or (glShaderSourceP = nil) or (glCompileShaderP = nil)
        or (glGetShaderivP = nil) or (glGetShaderInfoLogP = nil) or (glCreateProgramP = nil)
        or (glAttachShaderP = nil) or (glLinkProgramP = nil) or (glGetProgramivP = nil)
        or (glUseProgramP = nil) or (glGetUniformLocationP = nil) or (glUniform1fP = nil)
        or (glUniform1iP = nil) or (glGenFramebuffersP = nil) or (glBindFramebufferP = nil)
        or (glFramebufferTexture2DP = nil) or (glCheckFramebufferStatusP = nil) then
        exit;

    shader:= glCreateShaderP(SH_FRAGMENT);
    src:= PChar(convSource);
    glShaderSourceP(shader, 1, @src, nil);
    glCompileShaderP(shader);
    glGetShaderivP(shader, SH_COMPILE_STATUS, @status);
    if status = 0 then
        begin
        log[0]:= #0;
        glGetShaderInfoLogP(shader, 511, nil, @log[0]);
        WriteLnToConsole('Frame tap: converter does not compile: ' + shortstring(PChar(@log[0])));
        exit
        end;
    convProgram:= glCreateProgramP();
    glAttachShaderP(convProgram, shader);
    glLinkProgramP(convProgram);
    glGetProgramivP(convProgram, PROG_LINK_STATUS, @status);
    if status = 0 then
        begin
        WriteLnToConsole('Frame tap: converter does not link');
        exit
        end;

    // the screen to read from, and the texture the converter draws into
    glGenTextures(1, @convTexture);
    glBindTexture(GL_TEXTURE_2D, convTexture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, TEX_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, TEX_CLAMP_TO_EDGE);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, frameWidth, frameHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nil);

    glGenTextures(1, @target);
    glBindTexture(GL_TEXTURE_2D, target);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, frameWidth div 4, frameHeight * 3 div 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, nil);
    glBindTexture(GL_TEXTURE_2D, 0);

    glGenFramebuffersP(1, @convFramebuffer);
    glBindFramebufferP(FBO_FRAMEBUFFER, convFramebuffer);
    glFramebufferTexture2DP(FBO_FRAMEBUFFER, FBO_COLOR0, GL_TEXTURE_2D, target, 0);
    status:= glCheckFramebufferStatusP(FBO_FRAMEBUFFER);
    glBindFramebufferP(FBO_FRAMEBUFFER, 0);
    if status <> FBO_COMPLETE then
        begin
        WriteLnToConsole('Frame tap: no framebuffer to convert in');
        exit
        end;

    glUseProgramP(convProgram);
    glUniform1iP(glGetUniformLocationP(convProgram, 'tex'), 0);
    glUniform1fP(glGetUniformLocationP(convProgram, 'w'), frameWidth);
    glUniform1fP(glGetUniformLocationP(convProgram, 'h'), frameHeight);
    glUseProgramP(0);
    BuildConversion:= true
end;

// Draws the screen as NV12 into the converter's texture and leaves its
// framebuffer bound for reading; EndConversion puts back what the game uses.
procedure BeginConversion;
var i: LongInt;
begin
    glGetIntegerv(GL_VIEWPORT, @savedViewport[0]);
    glGetIntegerv(TEX_BINDING_2D, @savedTexture);
    glGetIntegerv(FBO_BINDING, @savedFramebuffer);
    glGetIntegerv(PROG_CURRENT, @savedProgram);
    glGetIntegerv(GL_MATRIX_MODE, @savedMatrixMode);
    for i:= 0 to High(convCaps) do
        begin
        savedCaps[i]:= glIsEnabled(convCaps[i]) <> 0;
        glDisable(convCaps[i])
        end;

    glBindTexture(GL_TEXTURE_2D, convTexture);
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, frameWidth, frameHeight);

    glBindFramebufferP(FBO_FRAMEBUFFER, convFramebuffer);
    glViewport(0, 0, frameWidth div 4, frameHeight * 3 div 2);
    glUseProgramP(convProgram);
    glMatrixMode(GL_PROJECTION);
    glPushMatrix();
    glLoadIdentity();
    glMatrixMode(GL_MODELVIEW);
    glPushMatrix();
    glLoadIdentity();
    glBegin(GL_QUADS);
    glVertex2f(-1, -1);
    glVertex2f(1, -1);
    glVertex2f(1, 1);
    glVertex2f(-1, 1);
    glEnd();
    glPopMatrix();
    glMatrixMode(GL_PROJECTION);
    glPopMatrix();
    glMatrixMode(savedMatrixMode)
end;

procedure EndConversion;
var i: LongInt;
begin
    glUseProgramP(savedProgram);
    glBindFramebufferP(FBO_FRAMEBUFFER, savedFramebuffer);
    glViewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
    glBindTexture(GL_TEXTURE_2D, savedTexture);
    for i:= 0 to High(convCaps) do
        if savedCaps[i] then
            glEnable(convCaps[i])
end;

function SenderThread(data: Pointer): LongInt; cdecl;
var buf: LongInt;
begin
    repeat
        buf:= -1;
        SDL_LockMutex(senderLock);
        if queueLength > 0 then
            begin
            buf:= queue[queueHead];
            queueHead:= (queueHead + 1) mod pboCount;
            dec(queueLength)
            end;
        SDL_UnlockMutex(senderLock);

        if buf >= 0 then
            begin
            if SDLNet_TCP_Send(videoSock, pboPixels[buf], frameSize) < frameSize then
                senderFailed:= true;
            SDL_LockMutex(senderLock);
            pboState[buf]:= psDone;
            SDL_UnlockMutex(senderLock)
            end
        else
            SDL_Delay(1)
    until senderQuit;
    SenderThread:= 0
end;

procedure StopVideoTap;
begin
    tapFailed:= true;

    if sender <> nil then
        begin
        senderQuit:= true;
        SDL_WaitThread(sender, nil);
        sender:= nil
        end;
    if senderLock <> nil then
        begin
        SDL_DestroyMutex(senderLock);
        senderLock:= nil
        end;

    if videoSock <> nil then
        SDLNet_TCP_Close(videoSock);
    videoSock:= nil
end;

procedure PrepareFrames;
var i: LongInt;
    mode: string;
begin
    frameReady:= true;
    frameWidth:= cScreenWidth;
    frameHeight:= cScreenHeight;
    frameSize:= frameWidth * frameHeight * 4;
    readWidth:= frameWidth;
    readHeight:= frameHeight;
    readFormat:= GL_BGRA_FORMAT;
    perfFreq:= SDL_GetPerformanceFrequency();
    statStart:= SDL_GetPerformanceCounter();

    tapMode:= 2;
    mode:= GetEnvironmentVariable('HW_TAP_MODE');
    if mode <> '' then
        tapMode:= StrToIntDef(mode, 2);
    showStats:= GetEnvironmentVariable('HW_TAP_STATS') <> '';

    tapNV12:= GetEnvironmentVariable('HW_TAP_FORMAT') = 'nv12';
    if tapNV12 then
        begin
        glGetIntegerv(TEX_BINDING_2D, @savedTexture);
        if BuildConversion then
            begin
            frameSize:= frameWidth * frameHeight * 3 div 2;
            readWidth:= frameWidth div 4;
            readHeight:= frameHeight * 3 div 2;
            readFormat:= GL_RGBA
            end
        else
            begin
            WriteLnToConsole('Frame tap: cannot convert frames to NV12 here, stopping');
            tapFailed:= true
            end;
        glBindTexture(GL_TEXTURE_2D, savedTexture);
        if tapFailed then
            exit
        end;

    if (tapMode > 0) and (not LoadBufferFunctions) then
        begin
        WriteLnToConsole('Frame tap: no pixel buffer objects, reading frames the slow way');
        tapMode:= 0
        end;

    if tapMode = 0 then
        GetMem(frameBuffer, frameSize)
    else
        begin
        glGenBuffersP(pboCount, @pbo[0]);
        for i:= 0 to pboCount - 1 do
            begin
            glBindBufferP(PBO_PACK_BUFFER, pbo[i]);
            glBufferDataP(PBO_PACK_BUFFER, frameSize, nil, PBO_STREAM_READ)
            end;
        glBindBufferP(PBO_PACK_BUFFER, 0)
        end;

    if tapMode >= 2 then
        begin
        senderLock:= SDL_CreateMutex();
        sender:= SDL_CreateThread(@SenderThread, 'frametap', nil)
        end;

    if tapNV12 then
        WriteLnToConsole('Frame tap: mode ' + IntToStr(tapMode) + ', NV12')
    else
        WriteLnToConsole('Frame tap: mode ' + IntToStr(tapMode))
end;

procedure ReadFrame(target: Pointer);
begin
    glReadPixels(0, 0, readWidth, readHeight, readFormat, GL_UNSIGNED_BYTE, target)
end;

procedure ReportStats;
var elapsed: QWord;
begin
    elapsed:= SDL_GetPerformanceCounter() - statStart;
    WriteLnToConsole('Frame tap: ' + IntToStr(statFrames) + ' frames in '
        + IntToStr(Micros(elapsed) div 1000) + ' ms, per frame: read '
        + IntToStr(Micros(statRead) div statFrames) + ' us, collect '
        + IntToStr(Micros(statMap) div statFrames) + ' us, send '
        + IntToStr(Micros(statSend) div statFrames) + ' us, dropped '
        + IntToStr(statDropped));
    statFrames:= 0;
    statDropped:= 0;
    statRead:= 0;
    statMap:= 0;
    statSend:= 0;
    statStart:= SDL_GetPerformanceCounter()
end;

// mode 0: wait for the frame, then wait for the consumer
procedure TapFrameBlocking;
var t0, t1, t2: QWord;
begin
    t0:= SDL_GetPerformanceCounter();
    ReadFrame(frameBuffer);
    t1:= SDL_GetPerformanceCounter();
    if SDLNet_TCP_Send(videoSock, frameBuffer, frameSize) < frameSize then
        begin
        WriteLnToConsole('Frame tap: consumer is gone, stopping');
        StopVideoTap
        end;
    t2:= SDL_GetPerformanceCounter();
    inc(statRead, t1 - t0);
    inc(statSend, t2 - t1)
end;

// mode 1: start copying this frame, send one from a few frames ago
procedure TapFrameBuffered;
var t0, t1, t2, t3: QWord;
    current, oldest: LongInt;
    pixels: Pointer;
begin
    t0:= SDL_GetPerformanceCounter();
    current:= pboFrames mod pboCount;
    glBindBufferP(PBO_PACK_BUFFER, pbo[current]);
    ReadFrame(nil);
    inc(pboFrames);
    t1:= SDL_GetPerformanceCounter();
    t2:= t1;
    t3:= t1;

    if pboFrames >= pboCount then
        begin
        oldest:= (current + 1) mod pboCount;
        glBindBufferP(PBO_PACK_BUFFER, pbo[oldest]);
        pixels:= glMapBufferP(PBO_PACK_BUFFER, PBO_READ_ONLY);
        if pixels <> nil then
            begin
            t2:= SDL_GetPerformanceCounter();
            if SDLNet_TCP_Send(videoSock, pixels, frameSize) < frameSize then
                senderFailed:= true;
            t3:= SDL_GetPerformanceCounter();
            glUnmapBufferP(PBO_PACK_BUFFER)
            end
        end;
    glBindBufferP(PBO_PACK_BUFFER, 0);

    inc(statRead, t1 - t0);
    inc(statMap, t2 - t1);
    inc(statSend, t3 - t2);

    if senderFailed then
        begin
        WriteLnToConsole('Frame tap: consumer is gone, stopping');
        StopVideoTap
        end
end;

// mode 2: the game only starts the copies and hands over the finished ones
procedure TapFrameThreaded;
var t0, t1, t2: QWord;
    i, target, oldest: LongInt;
    finished: boolean;
    pixels: Pointer;
begin
    t0:= SDL_GetPerformanceCounter();
    inc(pboFrames);

    // take back the buffers the sender has finished with
    for i:= 0 to pboCount - 1 do
        begin
        SDL_LockMutex(senderLock);
        finished:= pboState[i] = psDone;
        SDL_UnlockMutex(senderLock);
        if finished then
            begin
            glBindBufferP(PBO_PACK_BUFFER, pbo[i]);
            glUnmapBufferP(PBO_PACK_BUFFER);
            pboState[i]:= psIdle
            end
        end;

    // start copying this frame, unless the sender is too far behind
    target:= -1;
    for i:= 0 to pboCount - 1 do
        if (target < 0) and (pboState[(pboFrames + i) mod pboCount] = psIdle) then
            target:= (pboFrames + i) mod pboCount;
    if target >= 0 then
        begin
        glBindBufferP(PBO_PACK_BUFFER, pbo[target]);
        ReadFrame(nil);
        pboState[target]:= psPending;
        pboAge[target]:= pboFrames
        end
    else
        inc(statDropped);
    t1:= SDL_GetPerformanceCounter();

    // hand over the oldest copy that has had two frames to finish
    oldest:= -1;
    for i:= 0 to pboCount - 1 do
        if (pboState[i] = psPending) and (pboFrames - pboAge[i] >= 2)
            and ((oldest < 0) or (pboAge[i] < pboAge[oldest])) then
            oldest:= i;
    if oldest >= 0 then
        begin
        glBindBufferP(PBO_PACK_BUFFER, pbo[oldest]);
        pixels:= glMapBufferP(PBO_PACK_BUFFER, PBO_READ_ONLY);
        if pixels = nil then
            pboState[oldest]:= psIdle
        else
            begin
            pboPixels[oldest]:= pixels;
            SDL_LockMutex(senderLock);
            pboState[oldest]:= psQueued;
            queue[(queueHead + queueLength) mod pboCount]:= oldest;
            inc(queueLength);
            SDL_UnlockMutex(senderLock)
            end
        end;
    glBindBufferP(PBO_PACK_BUFFER, 0);
    t2:= SDL_GetPerformanceCounter();

    inc(statRead, t1 - t0);
    inc(statMap, t2 - t1);

    if senderFailed then
        begin
        WriteLnToConsole('Frame tap: consumer is gone, stopping');
        StopVideoTap
        end
end;

procedure TapFrame;
begin
    if (cStreamVideoPort = 0) or tapFailed then
        exit;

    Connect;
    if videoSock = nil then
        begin
        tapFailed:= true;
        exit
        end;

    if not frameReady then
        PrepareFrames;
    if tapFailed then
        begin
        StopVideoTap;
        exit
        end;

    // the consumer expects one fixed size
    if (cScreenWidth <> frameWidth) or (cScreenHeight <> frameHeight) then
        begin
        WriteLnToConsole('Frame tap: screen size changed, stopping');
        StopVideoTap;
        exit
        end;

    if tapNV12 then
        BeginConversion;
    case tapMode of
        0: TapFrameBlocking;
        1: TapFrameBuffered;
        else TapFrameThreaded
    end;
    if tapNV12 then
        EndConversion;

    inc(statFrames);
    if showStats and (statFrames >= statsFrames) then
        ReportStats
end;

function RingAt(offset: LongInt): Pointer;
begin
    RingAt:= Pointer(PtrUInt(audioRing) + PtrUInt(offset))
end;

// called by the mixer: only ever copies, never waits for the consumer
procedure TapPostMix(udata: pointer; stream: PByte; len: LongInt); cdecl;
var first: LongInt;
begin
    SDL_LockMutex(audioLock);
    if audioRingSize - audioCount >= len then
        begin
        first:= audioRingSize - audioTail;
        if first > len then
            first:= len;
        Move(stream^, RingAt(audioTail)^, first);
        if first < len then
            Move(Pointer(PtrUInt(stream) + PtrUInt(first))^, audioRing^, len - first);
        audioTail:= (audioTail + len) mod audioRingSize;
        inc(audioCount, len)
        end;
    SDL_UnlockMutex(audioLock)
end;

function AudioSenderThread(data: Pointer): LongInt; cdecl;
var chunk: PByte;
    n, first: LongInt;
begin
    GetMem(chunk, audioChunkSize);
    repeat
        SDL_LockMutex(audioLock);
        n:= audioCount;
        if n > audioChunkSize then
            n:= audioChunkSize;
        if n > 0 then
            begin
            first:= audioRingSize - audioHead;
            if first > n then
                first:= n;
            Move(RingAt(audioHead)^, chunk^, first);
            if first < n then
                Move(audioRing^, Pointer(PtrUInt(chunk) + PtrUInt(first))^, n - first);
            audioHead:= (audioHead + n) mod audioRingSize;
            dec(audioCount, n)
            end;
        SDL_UnlockMutex(audioLock);

        if n > 0 then
            begin
            if (not audioFailed) and (SDLNet_TCP_Send(audioSock, chunk, n) < n) then
                audioFailed:= true
            end
        else
            SDL_Delay(5)
    until audioQuit;
    FreeMem(chunk);
    AudioSenderThread:= 0
end;

procedure InitAudioTap;
begin
    if cStreamAudioPort = 0 then
        exit;

    Connect;
    if audioSock <> nil then
        begin
        GetMem(audioRing, audioRingSize);
        audioLock:= SDL_CreateMutex();
        audioThread:= SDL_CreateThread(@AudioSenderThread, 'audiotap', nil);
        Mix_SetPostMix(@TapPostMix, nil)
        end
end;

procedure freeModule;
begin
    if audioThread <> nil then
        begin
        Mix_SetPostMix(nil, nil);
        audioQuit:= true;
        SDL_WaitThread(audioThread, nil);
        audioThread:= nil;
        SDL_DestroyMutex(audioLock);
        audioLock:= nil;
        FreeMem(audioRing);
        audioRing:= nil
        end;
    if audioSock <> nil then
        begin
        SDLNet_TCP_Close(audioSock);
        audioSock:= nil
        end;
    StopVideoTap;
    if frameBuffer <> nil then
        FreeMem(frameBuffer);
    frameBuffer:= nil
end;

end.
