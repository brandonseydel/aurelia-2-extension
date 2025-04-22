import {
    DocumentFormattingParams,
    TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { log } from '../utils/logger';

/**
 * Handles document formatting requests.
 * Currently a placeholder - no actual formatting is performed.
 */
export async function handleDocumentFormattingRequest(
    params: DocumentFormattingParams,
    documents: TextDocuments<TextDocument>
): Promise<TextEdit[]> {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);

    if (!document || !uri.endsWith('.html')) {
        log('debug', '[onDocumentFormatting] Not an HTML document, skipping.');
        return [];
    }

    log('warn', `[onDocumentFormatting] Formatting for ${uri} requested, but not implemented.`);

    // Proper formatting requires an Aurelia-aware formatter integration.
    // Return empty edits to indicate no changes.
    return [];
} 