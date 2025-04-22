import * as ts from 'typescript';
import {
    CodeActionParams,
    CodeAction,
    CodeActionKind,
    WorkspaceEdit,
    TextEdit,
    TextDocumentEdit,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';

/**
 * Handles code action requests.
 */
export async function handleCodeActionRequest(
    params: CodeActionParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService
): Promise<CodeAction[] | undefined> {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const codeActions: CodeAction[] = [];
    const startOffset = document.offsetAt(params.range.start);
    const endOffset = document.offsetAt(params.range.end);

    const relevantMappings = docInfo.mappings.filter(mapping => 
        Math.max(startOffset, mapping.htmlExpressionLocation.startOffset) <=
               Math.min(endOffset, mapping.htmlExpressionLocation.endOffset)
    );

    if (relevantMappings.length === 0) return undefined;
    const primaryMapping = relevantMappings[0]; // Use first overlapping mapping

    // Map the HTML range to the virtual file range
    const virtualCodeActionOffset = mapHtmlOffsetToVirtual(startOffset, primaryMapping);
    let virtualCodeActionEndOffset = mapHtmlOffsetToVirtual(endOffset, primaryMapping);
    virtualCodeActionEndOffset = Math.max(virtualCodeActionOffset, virtualCodeActionEndOffset);
    
    log('debug', `[onCodeAction] HTML Range[${startOffset}-${endOffset}] mapped to Virtual Range[${virtualCodeActionOffset}-${virtualCodeActionEndOffset}]`);

    const errorCodes: number[] = params.context.diagnostics
        .map(diag => Number(diag.code))
        .filter(code => !isNaN(code));

    try {
        const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
        log('debug', `[onCodeAction] Getting code fixes for: ${virtualFsPath} [${virtualCodeActionOffset}-${virtualCodeActionEndOffset}]`);
        const codeFixes = languageService.getCodeFixesAtPosition(
            virtualFsPath,
            virtualCodeActionOffset,
            virtualCodeActionEndOffset,
            errorCodes, 
            {}, 
            {} 
        );

        log('info', `[onCodeAction] TS returned ${codeFixes.length} code fixes.`);

        for (const fix of codeFixes) {
            // Focus on fixes that change the current virtual file
            const virtualChange = fix.changes.find(change => change.fileName === docInfo.virtualUri);
            if (!virtualChange) continue;
            
            const mappedEdits: TextEdit[] = [];

            for (const textChange of virtualChange.textChanges) {
                const virtualStart = textChange.span.start;
                const virtualEnd = textChange.span.start + textChange.span.length;

                let editMapping = docInfo.mappings.find(m =>
                    m.virtualValueRange.start <= virtualStart && virtualEnd <= m.virtualValueRange.end
                ) ?? primaryMapping; // Fallback to primary mapping
                if (!editMapping) continue;

                // Map Virtual Edit Span back to HTML (using transformation logic)
                let htmlStartOffset: number;
                let htmlEndOffset: number;
                const valueVirtualStart = editMapping.virtualValueRange.start;
                
                const containingTransformation = editMapping.transformations.find(t => 
                    virtualStart >= t.virtualRange.start && virtualStart < t.virtualRange.end
                 );

                 if (containingTransformation && containingTransformation.virtualRange.start === virtualStart) {
                    // Edit starts exactly at a transformation: map to original HTML
                    htmlStartOffset = containingTransformation.htmlRange.start;
                    // Estimate end offset based on original HTML length + new text length? 
                    // This is tricky. Simpler: Map end based on virtual end.
                    let accumulatedDeltaEnd = 0;
                    for (const t of editMapping.transformations) { if (t.virtualRange.end <= virtualEnd) accumulatedDeltaEnd += t.offsetDelta; }
                    htmlEndOffset = editMapping.htmlExpressionLocation.startOffset + (virtualEnd - valueVirtualStart) - accumulatedDeltaEnd;
                    // Ensure length isn't negative if newText is shorter
                    htmlEndOffset = Math.max(htmlStartOffset, htmlEndOffset); 

                 } else {
                     // Edit does not start exactly at a transformation
                     let accumulatedDeltaStart = 0;
                     for (const t of editMapping.transformations) { if (t.virtualRange.end <= virtualStart) accumulatedDeltaStart += t.offsetDelta; }
                     htmlStartOffset = editMapping.htmlExpressionLocation.startOffset + (virtualStart - valueVirtualStart) - accumulatedDeltaStart;
                     
                     // Map end similarly
                     let accumulatedDeltaEnd = 0;
                     for (const t of editMapping.transformations) { if (t.virtualRange.end <= virtualEnd) accumulatedDeltaEnd += t.offsetDelta; }
                     htmlEndOffset = editMapping.htmlExpressionLocation.startOffset + (virtualEnd - valueVirtualStart) - accumulatedDeltaEnd;
                 }

                // Clamp and validate
                const htmlExprStart = editMapping.htmlExpressionLocation.startOffset;
                const htmlExprEnd = editMapping.htmlExpressionLocation.endOffset;
                const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
                let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
                clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);

                if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart) {
                    const htmlRange = LSPRange.create(
                        document.positionAt(clampedHtmlStart),
                        document.positionAt(clampedHtmlEnd)
                    );
                    mappedEdits.push(TextEdit.replace(htmlRange, textChange.newText));
                } else {
                    log('warn', `[onCodeAction] Skipping edit due to invalid mapped HTML range [${clampedHtmlStart}-${clampedHtmlEnd}]`);
                }
            }

            if (mappedEdits.length > 0) {
                const workspaceEdit: WorkspaceEdit = {
                    documentChanges: [
                        TextDocumentEdit.create({ uri: htmlUri, version: document.version }, mappedEdits)
                    ]
                    // Using documentChanges is generally preferred
                    // changes: { [htmlUri]: mappedEdits }
                };
                const codeAction = CodeAction.create(
                    fix.description,
                    workspaceEdit,
                    CodeActionKind.QuickFix 
                );
                codeActions.push(codeAction);
                log('info', `[onCodeAction] Created action: ${fix.description}`);
            }
        }
    } catch (e) {
        log('error', `[onCodeAction] Error getting code fixes: ${e}`);
    }

    return codeActions.length > 0 ? codeActions : undefined;
} 