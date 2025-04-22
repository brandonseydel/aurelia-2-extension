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
export function fileExistsOnDisk(filePath: string): boolean {
  try {
    return ts.sys.fileExists(filePath);
  } catch (e) {
    log('error', `[fileExistsOnDisk] Error checking ${filePath}`, e);
    return false;
  }
}

// Helper: Converts PascalCase or camelCase to kebab-case
export function toKebabCase(str: string): string {
    if (!str) return '';
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2') // CamelCase to kebab-case
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2') // Handle adjacent caps like HTMLElement
        .toLowerCase();
} 