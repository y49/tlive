declare module 'qrcode-terminal' {
  const qr: {
    generate(text: string, opts?: { small?: boolean }, cb?: (out: string) => void): void;
  };
  export default qr;
}
