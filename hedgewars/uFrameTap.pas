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
 * little endian stereo at 44100 Hz.
 *)

unit uFrameTap;
interface

procedure TapFrame;
procedure InitAudioTap;
procedure freeModule;

implementation
uses uVariables, uConsts, GLunit, SDLh, uConsole, uUtils;

const
    GL_BGRA_FORMAT = $80E1;
    connectAttempts = 50; // the encoder starts listening just before the engine

var videoSock, audioSock: PTCPSocket;
    frameBuffer: PByte;
    frameSize: LongInt;
    frameWidth, frameHeight: LongInt;
    tapFailed: boolean;

function OpenSocket(port: LongInt): PTCPSocket;
var ipaddr: TIPAddress;
    attempt: LongInt;
begin
    OpenSocket:= nil;
    if SDLNet_ResolveHost(ipaddr, PChar('127.0.0.1'), port) <> 0 then
        exit;

    for attempt:= 1 to connectAttempts do
        begin
        OpenSocket:= SDLNet_TCP_Open(ipaddr);
        if OpenSocket <> nil then
            exit;
        SDL_Delay(100)
        end
end;

procedure StopVideoTap;
begin
    tapFailed:= true;
    if videoSock <> nil then
        SDLNet_TCP_Close(videoSock);
    videoSock:= nil
end;

procedure TapFrame;
begin
    if (cStreamVideoPort = 0) or tapFailed then
        exit;

    if videoSock = nil then
        begin
        WriteToConsole('Frame tap: connecting to port ' + IntToStr(cStreamVideoPort) + ' ');
        videoSock:= OpenSocket(cStreamVideoPort);
        if videoSock = nil then
            begin
            WriteLnToConsole(msgFailed);
            tapFailed:= true;
            exit
            end;
        WriteLnToConsole(msgOK);
        frameWidth:= cScreenWidth;
        frameHeight:= cScreenHeight;
        frameSize:= frameWidth * frameHeight * 4;
        GetMem(frameBuffer, frameSize)
        end;

    // the consumer expects one fixed size
    if (cScreenWidth <> frameWidth) or (cScreenHeight <> frameHeight) then
        begin
        WriteLnToConsole('Frame tap: screen size changed, stopping');
        StopVideoTap;
        exit
        end;

    glReadPixels(0, 0, frameWidth, frameHeight, GL_BGRA_FORMAT, GL_UNSIGNED_BYTE, frameBuffer);
    if SDLNet_TCP_Send(videoSock, frameBuffer, frameSize) < frameSize then
        begin
        WriteLnToConsole('Frame tap: consumer is gone, stopping');
        StopVideoTap
        end
end;

procedure TapPostMix(udata: pointer; stream: PByte; len: LongInt); cdecl;
begin
    if audioSock <> nil then
        if SDLNet_TCP_Send(audioSock, stream, len) < len then
            begin
            SDLNet_TCP_Close(audioSock);
            audioSock:= nil
            end
end;

procedure InitAudioTap;
begin
    if cStreamAudioPort = 0 then
        exit;

    WriteToConsole('Audio tap: connecting to port ' + IntToStr(cStreamAudioPort) + ' ');
    audioSock:= OpenSocket(cStreamAudioPort);
    if audioSock = nil then
        WriteLnToConsole(msgFailed)
    else
        begin
        WriteLnToConsole(msgOK);
        Mix_SetPostMix(@TapPostMix, nil)
        end
end;

procedure freeModule;
begin
    if audioSock <> nil then
        begin
        Mix_SetPostMix(nil, nil);
        SDLNet_TCP_Close(audioSock);
        audioSock:= nil
        end;
    StopVideoTap;
    if frameBuffer <> nil then
        FreeMem(frameBuffer);
    frameBuffer:= nil
end;

end.
