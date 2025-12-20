/**
 * Simple base64 encoding/decoding for chat data storage.
 * This provides basic encoding to store chat data in a non-plain-text format.
 */

/**
 * Encode data using base64.
 * @param data - The data to encode
 * @param projectRoot - Project root (unused, kept for API compatibility)
 * @returns Base64-encoded string
 */
export function encodeChatData(data: string, projectRoot?: string): string {
  return Buffer.from(data, 'utf8').toString('base64');
}

/**
 * Decode base64-encoded data.
 * @param encodedData - The base64-encoded data
 * @param projectRoot - Project root (unused, kept for API compatibility)
 * @returns Decoded string
 */
export function decodeChatData(encodedData: string, projectRoot?: string): string {
  try {
    return Buffer.from(encodedData, 'base64').toString('utf8');
  } catch (error) {
    // If decoding fails, try to parse as plain JSON (migration from legacy encrypted format)
    // or return as-is if it's already plain text
    if (isEncoded(encodedData)) {
      throw new Error('Legacy encrypted format detected. Please recreate your chats.');
    }
    // If it's not base64, assume it's plain text (for migration)
    return encodedData;
  }
}

/**
 * Check if a string appears to be base64-encoded or legacy encrypted format.
 */
export function isEncoded(data: string): boolean {
  // Check for legacy encrypted format (iv:tag:encrypted) - 3 parts separated by colons
  const parts = data.split(':');
  if (parts.length === 3) {
    // Legacy encrypted format
    return true;
  }
  
  // Check if it's valid base64 (not plain JSON)
  // Base64 strings are typically longer and don't start with { or [
  if (data.trim().startsWith('{') || data.trim().startsWith('[')) {
    // Looks like plain JSON, not base64
    return false;
  }
  
  // Try to decode as base64
  try {
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    // If it decodes successfully and looks like JSON, it's base64-encoded
    return decoded.trim().startsWith('{') || decoded.trim().startsWith('[');
  } catch {
    return false;
  }
}


