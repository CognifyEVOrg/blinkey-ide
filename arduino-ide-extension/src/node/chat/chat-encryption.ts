import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Derive an encryption key from the project root path.
 * This ensures each project has its own encryption key.
 */
function deriveKey(projectRoot: string): Buffer {
  // Use the project root path as the salt source
  // This ensures each project has a unique key
  const salt = pbkdf2Sync(projectRoot, 'blinky-chat-encryption-salt', 1000, SALT_LENGTH, 'sha256');
  
  // Derive the actual encryption key from project root
  return pbkdf2Sync(projectRoot, salt.toString('hex'), ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt data using AES-256-GCM.
 * Returns base64-encoded string: iv:tag:encryptedData
 */
export function encryptChatData(data: string, projectRoot: string): string {
  const key = deriveKey(projectRoot);
  const iv = randomBytes(IV_LENGTH);
  
  const cipher = createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  const tag = cipher.getAuthTag();
  
  // Return format: iv:tag:encryptedData (all base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt data encrypted with encryptChatData.
 * Expects format: iv:tag:encryptedData (all base64)
 */
export function decryptChatData(encryptedData: string, projectRoot: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }
  
  const [ivBase64, tagBase64, encrypted] = parts;
  const iv = Buffer.from(ivBase64, 'base64');
  const tag = Buffer.from(tagBase64, 'base64');
  
  const key = deriveKey(projectRoot);
  
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Check if a string appears to be encrypted (has the expected format).
 */
export function isEncrypted(data: string): boolean {
  const parts = data.split(':');
  return parts.length === 3 && parts.every(part => {
    try {
      Buffer.from(part, 'base64');
      return true;
    } catch {
      return false;
    }
  });
}
