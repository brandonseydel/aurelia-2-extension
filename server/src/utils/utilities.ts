import * as ts from 'typescript';
import { AURELIA_BINDING_SUFFIXES, AURELIA_TEMPLATE_CONTROLLERS, AURELIA_SPECIAL_ATTRIBUTES } from '../constants';
import { log } from './logger';

// Helper: Converts kebab-case to PascalCase
export function kebabToPascalCase(str: string): string {
  return str.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

// Checks if an attribute looks like an Aurelia binding command or template controller
export function isAureliaAttribute(attrName: string): boolean {
    if (AURELIA_TEMPLATE_CONTROLLERS.includes(attrName)) {
        return true;
    }
    if (AURELIA_SPECIAL_ATTRIBUTES.includes(attrName)) {
        return true; 
    }
    if (AURELIA_BINDING_SUFFIXES.some((suffix: string) => attrName.endsWith(suffix))) {
        return true;
    }
    if (attrName.includes('.') && !attrName.startsWith('.') && !attrName.endsWith('.')) {
        return true;
    }
    return false;
}

// Helper to convert offset to Line/Column (1-based)
export function calculateLocationFromOffset(content: string, targetOffset: number): { line: number; col: number } | null {
    let line = 1;
    let col = 1;
    for (let i = 0; i < targetOffset && i < content.length; i++) {
        if (content[i] === '\n') {
            line++;
            col = 1;
        } else {
            col++;
        }
    }
    if (targetOffset > content.length) return null; // Offset out of bounds
    return { line, col };
}

// Function to explicitly check if a file exists on disk
const fileExistsCache = new Map<string, { exists: boolean, timestamp: number }>();
const FILE_CACHE_TTL = 10000; // 10 seconds cache TTL

export function fileExistsOnDisk(filePath: string): boolean {
  const now = Date.now();
  const cachedResult = fileExistsCache.get(filePath);
  
  // If we have a valid cache entry that hasn't expired
  if (cachedResult && (now - cachedResult.timestamp) < FILE_CACHE_TTL) {
    return cachedResult.exists;
  }
  
  try {
    const exists = ts.sys.fileExists(filePath);
    // Update cache with new result
    fileExistsCache.set(filePath, { exists, timestamp: now });
    return exists;
  } catch (e) {
    log('error', `[fileExistsOnDisk] Error checking ${filePath}`, e);
    // Cache negative result too, but with shorter TTL in case of errors
    fileExistsCache.set(filePath, { exists: false, timestamp: now });
    return false;
  }
}

// Function to explicitly clear the file existence cache
export function clearFileExistsCache(): void {
  fileExistsCache.clear();
}

// Function to remove a specific entry from the file existence cache
export function invalidateFileExistsCache(filePath: string): void {
  fileExistsCache.delete(filePath);
}

// Helper: Converts PascalCase or camelCase to kebab-case
export function toKebabCase(str: string): string {
    if (!str) return '';
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2') // CamelCase to kebab-case
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2') // Handle adjacent caps like HTMLElement
        .toLowerCase();
} 