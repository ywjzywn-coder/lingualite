/** SHA-256 十六进制摘要，用于缓存键。crypto.subtle 在扩展页面与 SW 中均可用。 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 短摘要，取前 16 位十六进制字符，足够避免碰撞。 */
export async function shortHash(input: string): Promise<string> {
  return (await sha256Hex(input)).slice(0, 16);
}
