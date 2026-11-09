declare module "qrcode" {
  export interface QRCodeCreateResult {
    modules: { size: number; data: Uint8Array };
  }
  export function create(text: string, options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }): QRCodeCreateResult;
  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    width?: number;
    type?: "image/png";
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  const api: { toDataURL: typeof toDataURL; create: typeof create };
  export default api;
}
