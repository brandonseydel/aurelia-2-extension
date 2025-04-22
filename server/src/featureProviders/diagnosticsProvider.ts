import * as ts from 'typescript';
import {
    Diagnostic,
    DiagnosticSeverity,
    Range as LSPRange,
    Connection
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo } from '../common/types'; 
import { serverSettings } from '../common/settings';
import { log } from '../utils/logger';

/**
 * Calculates and sends diagnostics for an Aurelia HTML file.
 */
export function updateDiagnostics(
    htmlUriString: string, 
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    connection: Connection
): void { 
    if (!serverSettings.diagnostics.enable) {
        log('debug', '[updateDiagnostics] Diagnostics disabled via settings.');
        connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
        return;
    }
    
    const docInfo = aureliaDocuments.get(htmlUriString); 
    const document = documents.get(htmlUriString);

    if (!docInfo || !document || !languageService) {
        log('debug', `[updateDiagnostics] Skipping diagnostics for ${htmlUriString} - no docInfo, document, or LS.`);
        connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
        return;
    }
    
    const virtualUriToUse = docInfo.virtualUri; 
    const virtualPath = URI.parse(virtualUriToUse).fsPath;
    log('debug', `[updateDiagnostics] Getting diagnostics for virtual path: ${virtualPath}`);
    
    let allVirtualDiagnostics: ts.Diagnostic[] = [];
    try {
        const semanticDiagnostics = languageService.getSemanticDiagnostics(virtualPath);
        const syntacticDiagnostics = languageService.getSyntacticDiagnostics(virtualPath);
        allVirtualDiagnostics = [...semanticDiagnostics, ...syntacticDiagnostics];
    } catch (e) {
        log('error', `[updateDiagnostics] Error getting TS diagnostics for ${virtualPath}`, e);
        // Send empty diagnostics on error?
        connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
        return;
    }

    const htmlDiagnostics: Diagnostic[] = [];

    for (const virtualDiag of allVirtualDiagnostics) {
        if (virtualDiag.start === undefined || virtualDiag.length === undefined) continue;

        const virtualDiagStart = virtualDiag.start;
        const virtualDiagEnd = virtualDiag.start + virtualDiag.length;
        let mapped = false;

        for (const mapping of docInfo.mappings) {
            if (Math.max(virtualDiagStart, mapping.virtualValueRange.start) < Math.min(virtualDiagEnd, mapping.virtualValueRange.end)) {
                // Map the virtual diagnostic range back to the HTML range
                let accumulatedOffsetDeltaBeforeStart = 0;
                for (const transform of mapping.transformations) {
                    if (transform.virtualRange.end <= virtualDiagStart) {
                        accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                    }
                }
                const baseHtmlOffset = mapping.htmlExpressionLocation.startOffset;
                const baseVirtualOffset = mapping.virtualValueRange.start;
                const htmlDiagStartOffset = baseHtmlOffset + (virtualDiagStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                
                // Map end offset similarly
                 let accumulatedOffsetDeltaBeforeEnd = 0;
                 for (const transform of mapping.transformations) {
                    if (transform.virtualRange.end <= virtualDiagEnd) {
                        accumulatedOffsetDeltaBeforeEnd += transform.offsetDelta;
                    }
                }
                 const htmlDiagEndOffset = baseHtmlOffset + (virtualDiagEnd - baseVirtualOffset) - accumulatedOffsetDeltaBeforeEnd;

                // Clamp and validate
                const htmlExprStart = mapping.htmlExpressionLocation.startOffset;
                const htmlExprEnd = mapping.htmlExpressionLocation.endOffset;
                const clampedHtmlStart = Math.max(htmlDiagStartOffset, htmlExprStart);
                let clampedHtmlEnd = Math.min(htmlDiagEndOffset, htmlExprEnd);
                clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);

                 if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart) {
                    const htmlRange = LSPRange.create(
                        document.positionAt(clampedHtmlStart),
                        document.positionAt(clampedHtmlEnd)
                    );

                    htmlDiagnostics.push({
                        severity: mapDiagnosticSeverity(virtualDiag.category),
                        range: htmlRange,
                        message: ts.flattenDiagnosticMessageText(virtualDiag.messageText, '\n'),
                        source: 'Aurelia Linter (via TS)',
                        code: virtualDiag.code,
                    });
                    mapped = true;
                    // Don't break, diagnostic might span multiple mappings conceptually?
                 } else {
                      log('warn', `[updateDiagnostics] Skipping diagnostic due to invalid mapped range: HTML[${clampedHtmlStart}-${clampedHtmlEnd}] from Virtual[${virtualDiagStart}-${virtualDiagEnd}]`);
                 }
            }
        }
        if (!mapped) {
             log('debug', `[updateDiagnostics] Diagnostic could not be mapped to specific HTML expression: ${ts.flattenDiagnosticMessageText(virtualDiag.messageText, '\n')} (Code: ${virtualDiag.code})`);
        }
    }

    connection.sendDiagnostics({ uri: htmlUriString, diagnostics: htmlDiagnostics });
    log('info', `[updateDiagnostics] Sent ${htmlDiagnostics.length} diagnostics for ${htmlUriString}`);
}

/**
 * Maps TS DiagnosticCategory to LSP DiagnosticSeverity
 */
function mapDiagnosticSeverity(category: ts.DiagnosticCategory): DiagnosticSeverity {
    switch (category) {
        case ts.DiagnosticCategory.Error: return DiagnosticSeverity.Error;
        case ts.DiagnosticCategory.Warning: return DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Message: return DiagnosticSeverity.Information;
        case ts.DiagnosticCategory.Suggestion: return DiagnosticSeverity.Hint;
        default: return DiagnosticSeverity.Information;
    }
} 