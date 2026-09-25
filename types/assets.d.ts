declare module "*.mp3" {
  /** esbuild 的 base64 loader：默认导出为不含前缀的 Base64 字符串 */
  const base64: string;
  export default base64;
}
