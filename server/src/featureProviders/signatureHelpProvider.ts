import * as ts from 'typescript';
import {
    SignatureHelpParams,
    SignatureHelp,
    SignatureHelpTriggerKind,
    SignatureHelpContext,
    SignatureInformation,
    ParameterInformation
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';

// Make sure SignatureHelpTriggerCharacter is available if TS defines it
type SignatureHelpTriggerCharacter = ts.SignatureHelpTriggerCharacter;

/**
 * Handles signature help requests.
 */
export async function handleSignatureHelpRequest(
    params: SignatureHelpParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService
): Promise<SignatureHelp | undefined> {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);
    log('debug', `[onSignatureHelp] Request at offset ${offset}. Trigger: ${params.context?.triggerKind}/${params.context?.triggerCharacter}`);

    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
            activeMapping = mapping;
            break;
        }
    }

    if (!activeMapping) {
        log('debug', `[onSignatureHelp] Offset ${offset} not within mapped expression.`);
        return undefined;
    }

    const virtualOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
    log('debug', `[onSignatureHelp] Mapped HTML Offset ${offset} to Virtual Offset ${virtualOffset}`);

    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    let signatureHelpItems: ts.SignatureHelpItems | undefined;
    try {
        signatureHelpItems = languageService.getSignatureHelpItems(virtualFsPath, virtualOffset, {
            triggerReason: mapSignatureHelpTriggerReason(params.context),
        });
    } catch (e) {
        log('error', `[onSignatureHelp] Error calling LS: ${e}`);
        return undefined; 
    }

    if (!signatureHelpItems) {
        log('debug', '[onSignatureHelp] TS returned no items.');
        return undefined;
    }

    return {
        signatures: signatureHelpItems.items.map(mapTsSignatureToLsp),
        activeSignature: signatureHelpItems.selectedItemIndex,
        activeParameter: signatureHelpItems.argumentIndex,
    };
}

function mapTsSignatureToLsp(item: ts.SignatureHelpItem): SignatureInformation {
    const label = ts.displayPartsToString(item.prefixDisplayParts) +
                  item.parameters.map(p => ts.displayPartsToString(p.displayParts)).join(ts.displayPartsToString(item.separatorDisplayParts)) +
                  ts.displayPartsToString(item.suffixDisplayParts);
    const parameters: ParameterInformation[] = item.parameters.map(p => {
        const parameterLabel = ts.displayPartsToString(p.displayParts);
        const parameterDoc = ts.displayPartsToString(p.documentation);
        return ParameterInformation.create(parameterLabel, parameterDoc);
    });
    const signatureDoc = ts.displayPartsToString(item.documentation);
    return SignatureInformation.create(label, signatureDoc, ...parameters);
}

function mapSignatureHelpTriggerReason(context?: SignatureHelpContext): ts.SignatureHelpTriggerReason {
    if (!context) return { kind: 'invoked' };
    switch (context.triggerKind) {
        case SignatureHelpTriggerKind.Invoked:
            return { kind: 'invoked' };
        case SignatureHelpTriggerKind.TriggerCharacter:
            const tsTriggerChars: ReadonlyArray<SignatureHelpTriggerCharacter> = ['(', ',', '<'];
            if (context.triggerCharacter && tsTriggerChars.includes(context.triggerCharacter as SignatureHelpTriggerCharacter)) {
                return {
                    kind: 'characterTyped',
                    triggerCharacter: context.triggerCharacter as SignatureHelpTriggerCharacter,
                };
            }
            return { kind: 'invoked' }; 
        case SignatureHelpTriggerKind.ContentChange:
            return { kind: 'retrigger' }; 
        default:
            return { kind: 'invoked' };
    }
} 