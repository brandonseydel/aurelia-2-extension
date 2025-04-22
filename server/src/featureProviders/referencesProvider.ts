import * as ts from 'typescript';
import {
    ReferenceParams,
    Location as LSPLocation,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';

/**
 * Handles find references requests.
 */
export async function handleReferencesRequest(
    params: ReferenceParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService
): Promise<LSPLocation[] | undefined> {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);

    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
            activeMapping = mapping;
            break;
        }
    }

    if (!activeMapping) {
        log('debug', `[onReferences] Offset ${offset} not within mapped expression.`);
        return undefined; 
    }

    const virtualOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
    log('debug', `[onReferences] Mapped HTML Offset ${offset} to Virtual Offset ${virtualOffset}`);

    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    let referencedSymbols: ts.ReferencedSymbol[] | undefined;
    try {
        referencedSymbols = languageService.findReferences(virtualFsPath, virtualOffset);
    } catch(e) {
        log('error', `[onReferences] Error calling LS: ${e}`);
        return undefined;
    }

    if (!referencedSymbols) {
        log('debug', "[onReferences] TS could not find reference symbols.");
        return undefined;
    }

    const locations: LSPLocation[] = [];
    log('info', `[onReferences] Found ${referencedSymbols.length} referenced symbols.`);

    for (const symbol of referencedSymbols) {
        log('debug', `  - Symbol has ${symbol.references.length} references.`);
        for (const reference of symbol.references) {
             const targetFsPath = reference.fileName;
             const targetUri = URI.file(targetFsPath).toString();
             const locationVirtualSpan = reference.textSpan;
             const virtualStart = locationVirtualSpan.start;
             const virtualEnd = virtualStart + locationVirtualSpan.length;
             let targetRange: LSPRange | undefined;

             if (targetFsPath === docInfo.vmFsPath) {
                 // Case 1: Location is in the original ViewModel file
                 const vmDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPath) ?? '');
                 if (vmDocument) {
                      targetRange = LSPRange.create(
                          vmDocument.positionAt(virtualStart),
                          vmDocument.positionAt(virtualEnd)
                      );
                 }
             } else if (targetFsPath === URI.parse(docInfo.virtualUri).fsPath) {
                 // Case 2: Location is in the Virtual File (map back to HTML)
                  let locationMapping = docInfo.mappings.find(m => 
                      // Check if reference span is contained within this mapping's virtual value range
                      m.virtualValueRange.start <= virtualStart && virtualEnd <= m.virtualValueRange.end
                  );
                  if (!locationMapping) {
                      log('warn', `[onReferences] Could not find mapping for virtual reference location [${virtualStart}-${virtualEnd}]`);
                      continue;
                  }
                 
                 // Map Virtual Span back to HTML Range (using transformation logic)
                 let htmlStartOffset: number;
                 let htmlEndOffset: number;
                 
                 const containingTransformation = locationMapping.transformations.find(t => 
                    virtualStart >= t.virtualRange.start && virtualStart < t.virtualRange.end
                 );

                 if (containingTransformation) {
                     htmlStartOffset = containingTransformation.htmlRange.start;
                     htmlEndOffset = containingTransformation.htmlRange.end;
                 } else {
                     let accumulatedOffsetDeltaBeforeStart = 0;
                     for (const transform of locationMapping.transformations) {
                         if (transform.virtualRange.end <= virtualStart) {
                             accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                         }
                     }
                     const baseHtmlOffset = locationMapping.htmlExpressionLocation.startOffset;
                     const baseVirtualOffset = locationMapping.virtualValueRange.start;
                     htmlStartOffset = baseHtmlOffset + (virtualStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                     const spanLength = virtualEnd - virtualStart;
                     htmlEndOffset = htmlStartOffset + spanLength;
                 }

                 // Clamp and validate
                 const htmlExprStart = locationMapping.htmlExpressionLocation.startOffset;
                 const htmlExprEnd = locationMapping.htmlExpressionLocation.endOffset;
                 const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
                 let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
                 clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);

                  if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart) {
                     targetRange = LSPRange.create(
                         document.positionAt(clampedHtmlStart),
                         document.positionAt(clampedHtmlEnd)
                     );
                 } else {
                     log('warn', `[onReferences] Invalid mapped HTML range [${clampedHtmlStart}-${clampedHtmlEnd}] for virtual reference [${virtualStart}-${virtualEnd}]`);
                     continue;
                 }
             } else {
                 // Case 3: Location is in some other TS file
                  const otherDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPath) ?? '');
                   if (otherDocument) {
                      targetRange = LSPRange.create(
                          otherDocument.positionAt(virtualStart),
                          otherDocument.positionAt(virtualEnd)
                      );
                   }
             }

             if (targetRange) {
                  locations.push(LSPLocation.create(targetUri, targetRange));
             }
        }
    }

    log('info', `[onReferences] Returning ${locations.length} mapped locations.`);
    return locations;
} 