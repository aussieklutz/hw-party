// Engine IPC framing: one length byte, then that many bytes of payload.

// a text command ("eskip", "ehjump", ...)
export function frame(text) {
  const b = Buffer.from(text, "utf8");
  if (b.length > 255) throw new Error("frame too long");
  return Buffer.concat([Buffer.from([b.length]), b]);
}

// a command byte followed by two big-endian int32s ('P' cursor delta, 'p' put):
// 1 length + 1 command + 4 + 4 = 10 bytes on the wire, a payload of 9
export function xyFrame(cmd, x, y) {
  const buf = Buffer.alloc(10);
  buf[0] = 9;
  buf[1] = cmd.charCodeAt(0);
  buf.writeInt32BE(x | 0, 2);
  buf.writeInt32BE(y | 0, 6);
  return buf;
}
