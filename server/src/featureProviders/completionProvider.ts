import * as ts from 'typescript';
import {
    CompletionParams,
    CompletionItem,
    CompletionItemKind,
    InsertTextFormat,
    Position,
    Range as LSPRange
} from 'vscode-languageserver/node';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node'; // For TextDocuments type
import { URI } from 'vscode-uri';
import * as parse5 from 'parse5';
import { DefaultTreeAdapterTypes } from 'parse5';
import {
    AureliaDocumentInfo,
    DetailedMapping,
    AureliaProjectComponentMap
} from '../common/types';
import { log } from '../utils/logger';
import { getViewModelMemberNames, mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';
import { AURELIA_BINDING_SUFFIXES, AURELIA_TEMPLATE_CONTROLLERS } from '../constants'; // Import necessary constants

// Type definitions
// Remove local type definition
// type AureliaProjectComponentMap = Map<string, { uri: string, type: 'element' | 'attribute', name: string, bindables?: string[] }>;

// Restore original Map definition for the cache, ensuring 'content' is required
type ViewModelMembersCache = Map<string, { content: string | undefined; members: string[] }>;

/**
 * Handles completion requests.
 * Needs access to various state maps and dependencies.
 */
export function handleCompletionRequest(
    params: CompletionParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    aureliaProjectComponents: AureliaProjectComponentMap,
    languageService: ts.LanguageService,
    viewModelMembersCache: ViewModelMembersCache
): CompletionItem[] | undefined {
    const htmlUriString = params.textDocument.uri;
    const document = documents.get(htmlUriString);
    if (!document || !htmlUriString.endsWith('.html')) return undefined;

    const offset = document.offsetAt(params.position);
    const docInfo = aureliaDocuments.get(htmlUriString);
    let activeMapping: DetailedMapping | undefined;

    if (docInfo) {
        log('debug', `[onCompletion] Checking offset ${offset} against ${docInfo.mappings.length} mappings.`);
        for (const mapping of docInfo.mappings) {
            const mapStart = mapping.htmlExpressionLocation.startOffset;
            const mapEnd = mapping.htmlExpressionLocation.endOffset;
            // Use <= for end offset to allow completion right after expression
            if (mapStart <= offset && offset <= mapEnd) {
                log('debug', `    - Offset ${offset} IS within [${mapStart}-${mapEnd}]. Setting active mapping.`);
                activeMapping = mapping;
                break;
            }
        }
    }

    // --- Branch 1: Completion OUTSIDE an Aurelia expression (HTML structure) ---
    if (!activeMapping) {
        const text = document.getText();
        const lookBehind = 100;
        const fragmentStartOffset = Math.max(0, offset - lookBehind);
        const fragment = text.substring(fragmentStartOffset, offset);
        const lookAhead = 50;
        const textAfterFragment = text.substring(offset, Math.min(text.length, offset + lookAhead));
        const triggerChar = params.context?.triggerCharacter;
        const charBeforeCursor = offset > 0 ? text[offset - 1] : '';

        let htmlCompletions: CompletionItem[] = [];
        log('info', `[onCompletion] HTML Context Analysis: Trigger='${triggerChar}', charBefore='${charBeforeCursor}'`);

        // === Improved Context Detection using parse5 ===
        try {
            const parsedFragment = parse5.parseFragment(fragment, { sourceCodeLocationInfo: true });
            const nodes = parsedFragment.childNodes;
            const relativeOffset = offset - fragmentStartOffset;
            let targetNode: DefaultTreeAdapterTypes.Node | undefined;
            let parentElement: DefaultTreeAdapterTypes.Element | undefined;
            let isInsideTagName = false;
            let isCompletingTagName = false;
            let isInsideAttributeName = false;
            let isCompletingAttributeName = false;
            let isInsideOpeningTagSpace = false;
            let currentTagName: string | undefined = undefined;

            function findContext(node: DefaultTreeAdapterTypes.Node, parent: DefaultTreeAdapterTypes.Element | undefined) {
                if (!node.sourceCodeLocation) return;
                const loc = node.sourceCodeLocation;
                if (loc.startOffset <= relativeOffset && relativeOffset <= loc.endOffset) {
                    targetNode = node;
                    parentElement = parent;

                    if (node.nodeName !== '#text' && node.nodeName !== '#comment' && 'tagName' in node && 'startTag' in loc && loc.startTag) {
                        const elementNode = node as DefaultTreeAdapterTypes.Element;
                        const startTag = loc.startTag;
                        const tagNameLength = elementNode.tagName.length;
                        const tagNameStart = startTag.startOffset + 1;
                        const tagNameEnd = tagNameStart + tagNameLength;

                        if (relativeOffset >= tagNameStart && relativeOffset <= tagNameEnd) {
                            isInsideTagName = true;
                            if (triggerChar === '<' || charBeforeCursor === '<' || text[tagNameStart - 1] === '<') {
                                isCompletingTagName = true;
                            }
                        }
                        else if (relativeOffset > tagNameEnd && relativeOffset <= startTag.endOffset) {
                            let isInAttribute = false;
                            if (loc.attrs) {
                                for (const attrName in loc.attrs) {
                                    const attrLoc = loc.attrs[attrName];
                                    if (relativeOffset >= attrLoc.startOffset && relativeOffset <= attrLoc.endOffset) {
                                        isInAttribute = true;
                                        if (relativeOffset <= attrLoc.startOffset + attrName.length) {
                                            isInsideAttributeName = true;
                                        }
                                        break;
                                    }
                                }
                            }
                            if (!isInAttribute) {
                                isInsideOpeningTagSpace = true;
                            }
                        }
                    }
                    if ('childNodes' in node && (node as DefaultTreeAdapterTypes.Element).childNodes.length > 0) {
                        (node as DefaultTreeAdapterTypes.Element).childNodes.forEach(child => findContext(child, node as DefaultTreeAdapterTypes.Element));
                    }
                }
            }
            nodes.forEach(node => findContext(node, undefined));

            // --- Context-Specific Completion Logic ---
            let provideElementCompletions = false;
            let provideAttributeCompletions = false;
            currentTagName = parentElement?.tagName;

            log('debug', `[onCompletion] HTML Context Detection: isInsideTagName=${isInsideTagName}, isInsideOpeningTagSpace=${isInsideOpeningTagSpace}, isInsideAttributeName=${isInsideAttributeName}, charBeforeCursor='${charBeforeCursor}'`);

            if (charBeforeCursor === '<' || isInsideTagName) {
                provideElementCompletions = true;
            } else if (isInsideOpeningTagSpace || isInsideAttributeName) {
                provideAttributeCompletions = true;
            } else if (targetNode?.nodeName === '#text' && triggerChar === '<') {
                provideElementCompletions = true;
            }
            else if (triggerChar === '.') {
                const textBeforeOffset = document.getText(LSPRange.create(Position.create(0, 0), params.position));
                const lastTagOpenMatch = textBeforeOffset.match(/<([a-zA-Z0-9-]+)[^>]*$/);
                const tagNameFromRegex = lastTagOpenMatch ? lastTagOpenMatch[1] : undefined;
                log('debug', `[onCompletion] Dot trigger detected. Preceding tag found via regex: ${tagNameFromRegex}`);

                if (tagNameFromRegex) {
                    const componentInfo = aureliaProjectComponents.get(tagNameFromRegex);
                    if (componentInfo?.type === 'element' && componentInfo.bindables && Array.isArray(componentInfo.bindables)) {
                        const textEndingBeforeDot = document.getText(LSPRange.create(Position.create(0, 0), document.positionAt(offset - 1)));
                        const wordMatch = textEndingBeforeDot.match(/([a-zA-Z0-9_-]+)$/);
                        const wordBeforeDot = wordMatch ? wordMatch[1] : '';
                        log('debug', `  - Word before dot: '${wordBeforeDot}'`);

                        // Check if the word is a known bindable OR a standard attribute like 'class' or 'style'
                        const isKnownBindable = componentInfo?.bindables?.includes(wordBeforeDot) ?? false;
                        // Let's be more general: check if it looks like a valid attribute name.
                        // This avoids needing a hardcoded list and works for data-*, aria-*, etc.
                        const isValidAttributeName = /^[a-zA-Z][a-zA-Z0-9-]*$/.test(wordBeforeDot);

                        if (wordBeforeDot && (isKnownBindable || isValidAttributeName)) {
                            const detailContext = isKnownBindable ? `bindable property '${wordBeforeDot}'` : `attribute '${wordBeforeDot}'`;
                            log('debug', `  - Word matches ${isKnownBindable ? 'bindable' : 'valid attribute name'}: ${wordBeforeDot}. Providing suffix completions.`);
                            AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                                // Provide suffix completion like 'bind', 'one-way' etc.
                                if (suffix !== '.ref') { // Typically .ref isn't used this way
                                    htmlCompletions.push({
                                        label: suffix.substring(1), // Suggest 'bind', 'one-way' etc.
                                        kind: CompletionItemKind.Event, // Using Event kind like before
                                        insertText: suffix.substring(1), // Insert just the command part
                                        insertTextFormat: InsertTextFormat.PlainText,
                                        detail: `Aurelia command ${suffix} on ${detailContext}`,
                                        // Filter text includes the original attribute for better matching if user typed 'class.bi'
                                        filterText: `${wordBeforeDot}${suffix}`,
                                        // Prioritize bindable suggestions slightly? Or keep unified?
                                        sortText: `0_${isKnownBindable ? 'bindable' : 'attribute'}_${wordBeforeDot}${suffix}`
                                    });
                                }
                            });
                            // Return *only* these suffix completions when triggered by a dot after a valid attribute/bindable
                            const distinctMap = new Map<string, CompletionItem>();
                            htmlCompletions.forEach(item => { if (!distinctMap.has(item.label)) { distinctMap.set(item.label, item); } });
                            const distinctCompletions = Array.from(distinctMap.values());
                            log('debug', `[onCompletion] HTML Context (Dot Trigger for ${detailContext}): Returning ${distinctCompletions.length} distinct command completions.`);
                            return distinctCompletions;
                        }
                    }
                }
                log('debug', `[onCompletion] Dot trigger logic finished without providing attribute suffix completions. No further HTML completions from this branch.`);
                // Return undefined or an empty array to signify no completions from this specific dot-trigger path
                return undefined;
            }
            else if (!provideAttributeCompletions && !provideElementCompletions && (charBeforeCursor === ' ' || triggerChar === undefined)) {
                const textBeforeOffset = document.getText(LSPRange.create(Position.create(0, 0), params.position));
                const tagMatch = textBeforeOffset.match(/<([a-zA-Z0-9-]+)\s*$/);

                if (tagMatch) {
                    const tagNameFromRegex = tagMatch[1];
                    log('debug', `[onCompletion] HTML Context: Triggering attribute completions based on fallback check (Trigger: ${triggerChar}, CharBefore: ${charBeforeCursor}). Tag found: ${tagNameFromRegex}`);
                    provideAttributeCompletions = true;
                    currentTagName = tagNameFromRegex;
                } else {
                    log('debug', '[onCompletion] HTML Context: Fallback check did not find preceding tag.');
                }
            }

            log('debug', `[onCompletion] HTML Context Flags: provideElements=${provideElementCompletions}, provideAttributes=${provideAttributeCompletions}, currentTagName=${currentTagName}`);

            // --- Generate Completions Based on Context ---
            if (provideElementCompletions) {
                log('debug', `[onCompletion] Providing Element completions. Project components count: ${aureliaProjectComponents.size}`);
                aureliaProjectComponents.forEach((info) => {
                    if (info.type === 'element') {
                        log('debug', `  - Adding element completion: ${info.name}`);
                        htmlCompletions.push({ label: info.name, kind: CompletionItemKind.Class, detail: `Au Element (${path.basename(URI.parse(info.uri).fsPath)})` });
                    }
                });
            }

            if (provideAttributeCompletions) {
                aureliaProjectComponents.forEach((info) => {
                    if (info.type === 'attribute') {
                        htmlCompletions.push({
                            label: info.name,
                            kind: CompletionItemKind.Property,
                            insertText: `${info.name}="$1"`,
                            insertTextFormat: InsertTextFormat.Snippet,
                            detail: `Au Attribute (${path.basename(URI.parse(info.uri).fsPath)})`,
                        });
                        AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                            if (suffix !== '.ref') {
                                htmlCompletions.push({
                                    label: `${info.name}${suffix}`,
                                    kind: CompletionItemKind.Event,
                                    insertText: `${info.name}${suffix}="\${1:expression}"`,
                                    insertTextFormat: InsertTextFormat.Snippet,
                                    detail: `Bind ${suffix} on ${info.name}`,
                                });
                            }
                        });
                    }
                });
                AURELIA_TEMPLATE_CONTROLLERS.forEach(controller => {
                    htmlCompletions.push({
                        label: controller,
                        kind: CompletionItemKind.Struct,
                        insertText: `${controller}="\${1:expression}"`,
                        insertTextFormat: InsertTextFormat.Snippet,
                        detail: `Aurelia Template Controller`,
                        sortText: `0_controller_${controller}`
                    });
                });

                if (currentTagName) {
                    const componentInfo = aureliaProjectComponents.get(currentTagName);
                    if (componentInfo?.type === 'element' && componentInfo.bindables && Array.isArray(componentInfo.bindables)) {
                        log('debug', `[onCompletion] Found element <${currentTagName}> with bindables: ${componentInfo.bindables.join(', ')}`);
                        componentInfo.bindables.forEach(bindableName => {
                            htmlCompletions.push({
                                label: bindableName,
                                kind: CompletionItemKind.Property,
                                insertText: `${bindableName}="$1"`,
                                insertTextFormat: InsertTextFormat.Snippet,
                                detail: `Bindable property for <${currentTagName}>`,
                                sortText: `0_bindable_${bindableName}`
                            });
                            AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                                if (suffix !== '.ref') {
                                    htmlCompletions.push({
                                        label: `${bindableName}${suffix}`,
                                        kind: CompletionItemKind.Event,
                                        insertText: `${bindableName}${suffix}="\${1:expression}"`,
                                        insertTextFormat: InsertTextFormat.Snippet,
                                        detail: `Bind ${suffix} on ${bindableName}`,
                                        sortText: `0_bindable_${bindableName}${suffix}`
                                    });
                                }
                            });
                        });
                    }
                }
            }
        } catch (parseError) {
            log('warn', `[onCompletion] HTML Context: Error parsing fragment: ${parseError}. Falling back.`);
            // Fallback logic omitted for brevity after refactor
        }

        if (htmlCompletions.length > 0) {
            const distinctMap = new Map<string, CompletionItem>();
            htmlCompletions.forEach(item => { if (!distinctMap.has(item.label)) { distinctMap.set(item.label, item); } });
            const distinctCompletions = Array.from(distinctMap.values());
            log('info', `[onCompletion] HTML Context: Returning ${distinctCompletions.length} distinct completions.`);
            return distinctCompletions;
        }
    }
    // --- End Branch 1 ---

    // --- Branch 2: Completion INSIDE an Aurelia expression --- 
    if (docInfo && activeMapping) {
        const memberNames = getViewModelMemberNames(docInfo.vmClassName, docInfo.vmFsPath, languageService, viewModelMembersCache);

        let virtualCompletionOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
        if (offset === activeMapping.htmlExpressionLocation.endOffset + 1 && params.context?.triggerCharacter === '.') {
            virtualCompletionOffset = activeMapping.virtualValueRange.end;
        }
        log('debug', `[onCompletion] Expression context. Mapped HTML Offset ${offset} to Virtual Offset ${virtualCompletionOffset}`);

        const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
        let completions: ts.WithMetadata<ts.CompletionInfo> | undefined;
        try {
            completions = languageService.getCompletionsAtPosition(
                virtualFsPath,
                virtualCompletionOffset,
                { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: true }
            );
        } catch (error) {
            log('error', `[onCompletion] Error calling languageService.getCompletionsAtPosition: ${error}`);
            return undefined;
        }

        if (!completions) {
            log('debug', "[onCompletion] TS returned no completions object.");
            return undefined;
        }

        let expressionCompletions: CompletionItem[] = [];
        expressionCompletions = completions.entries
            .filter(entry => {
                if (entry.name.startsWith('___expr_') || entry.name.startsWith('_this') || entry.name.startsWith('__filename') || entry.name.startsWith('__dirname')) return false;
                if (entry.kind === ts.ScriptElementKind.moduleElement ||
                    entry.kind === ts.ScriptElementKind.classElement ||
                    entry.kind === ts.ScriptElementKind.interfaceElement ||
                    entry.kind === ts.ScriptElementKind.typeElement ||
                    entry.kind === ts.ScriptElementKind.enumElement) {
                    return false;
                }
                if (entry.kind === ts.ScriptElementKind.keyword && !['true', 'false', 'null', 'undefined'].includes(entry.name)) {
                    return false;
                }
                return true;
            }).map((entry, index) => {
                const isViewModelMember = memberNames.includes(entry.name);
                let sortPriority = '9';
                if (isViewModelMember) sortPriority = '0';
                else sortPriority = '5';
                if (entry.kind === ts.ScriptElementKind.keyword) sortPriority = '8';
                return {
                    label: entry.name,
                    kind: mapCompletionKind(entry.kind),
                    insertText: entry.insertText ?? entry.name,
                    sortText: sortPriority + entry.sortText + index.toString().padStart(3, '0'),
                    detail: entry.kind,
                };
            });

        // Fallback for partially typed VM members
        const originalHtmlText = document.getText(LSPRange.create(document.positionAt(activeMapping.htmlExpressionLocation.startOffset), params.position));
        const textBeforeCursor = originalHtmlText;
        const simpleIdentifierRegex = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
        if (simpleIdentifierRegex.test(textBeforeCursor.trim())) {
            const trimmedText = textBeforeCursor.trim();
            const seemsLacking = expressionCompletions.length === 0 || !expressionCompletions.some(c => c.label.startsWith(trimmedText));
            if (seemsLacking) {
                log('debug', `[onCompletion] Triggering fallback completion for partial identifier: '${trimmedText}'`);
                const partialMatchMembers = memberNames.filter(memberName =>
                    memberName.startsWith(trimmedText) &&
                    !expressionCompletions.some(existing => existing.label === memberName)
                );
                partialMatchMembers.forEach(memberName => {
                    expressionCompletions.push({
                        label: memberName,
                        kind: CompletionItemKind.Property,
                        insertText: memberName,
                        sortText: '0_vm_partial_' + memberName,
                        detail: '(ViewModel Member)',
                    });
                });
            }
        }


        const charBeforeCursor = textBeforeCursor[textBeforeCursor.length - 1]?.trim();

        if (!charBeforeCursor) {
            let addedFallbackMembers = false;
            memberNames.forEach(memberName => {
                if (!expressionCompletions.some(existing => existing.label === memberName)) {
                    expressionCompletions.push({
                        label: memberName,
                        kind: CompletionItemKind.Property,
                        insertText: memberName,
                        sortText: '0_vm_always_' + memberName,
                        detail: '(ViewModel Member)',
                    });
                    addedFallbackMembers = true;
                }
            });
            log('debug', `[onCompletion] Added ${addedFallbackMembers ? 'some' : 'no'} missing VM members as fallbacks.`);
        }

        expressionCompletions.sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
        log('debug', `[onCompletion] Expression Context: Returning ${expressionCompletions.length} completion items after fallbacks.`);
        return expressionCompletions;
    }

    log('debug', `[onCompletion] Reached end of handler without returning completions for offset ${offset}.`);
    return undefined;
}

/**
 * Helper to map TS ScriptElementKind to LSP CompletionItemKind
 */
export function mapCompletionKind(kind: string): CompletionItemKind | undefined {
    switch (kind) {
        case ts.ScriptElementKind.memberVariableElement:
        case ts.ScriptElementKind.memberGetAccessorElement:
        case ts.ScriptElementKind.memberSetAccessorElement:
            return CompletionItemKind.Property;
        case ts.ScriptElementKind.memberFunctionElement:
            return CompletionItemKind.Method;
        case ts.ScriptElementKind.variableElement:
        case ts.ScriptElementKind.letElement:
        case ts.ScriptElementKind.constElement:
            return CompletionItemKind.Variable;
        case ts.ScriptElementKind.functionElement:
            return CompletionItemKind.Function;
        case ts.ScriptElementKind.keyword:
            return CompletionItemKind.Keyword;
        default:
            return undefined;
    }
} 