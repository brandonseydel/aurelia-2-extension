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
import { extractExpressionsFromHtml } from '../core/htmlParser'; // <<< REMOVE TYPE IMPORT
import { toKebabCase } from '../utils/utilities'; // <<< ADD IMPORT >>>

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
    viewModelMembersCache: ViewModelMembersCache,
    virtualFiles: Map<string, { content: string; version: number }>,
    program: ts.Program | undefined,
): CompletionItem[] | undefined {
    const htmlUriString = params.textDocument.uri;
    const document = documents.get(htmlUriString);
    if (!document || !htmlUriString.endsWith('.html')) return undefined;

    const offset = document.offsetAt(params.position);
    const docInfo = aureliaDocuments.get(htmlUriString);
    let activeMapping: DetailedMapping | undefined;

    // Use docInfo to get VM path etc., but use fresh parse for offset check
    if (docInfo) {
        const currentText = document.getText();
        const { expressions: freshExpressions } = extractExpressionsFromHtml(currentText);

        // Use ORIGINAL OFFSET for the check loop
        log('debug', `[onCompletion] Checking offset ${offset} against ${freshExpressions.length} freshly parsed expressions.`);

        for (const expr of freshExpressions) {
            const mapStart = expr.htmlLocation.startOffset;
            const mapEnd = expr.htmlLocation.endOffset;

            // Adjust check range
            let checkStart = mapStart;
            let checkEnd = mapEnd;
            if (expr.type === 'interpolation') {
                checkStart = mapStart - 2;
                checkEnd = mapEnd + 2;
            }

            // Use original offset here
            const isWithinRange = checkStart <= offset && (expr.type === 'interpolation' ? offset < checkEnd : offset <= checkEnd);

            // Log the check details (using original offset)
            log('debug', `[onCompletion] Checking Expression Range:`);
            log('debug', `  - Cursor Offset: ${offset}`);
            log('debug', `  - Expression Type: ${expr.type}`);
            log('debug', `  - Raw HTML Range [mapStart-mapEnd]: [${mapStart}-${mapEnd}]`);
            log('debug', `  - Check Range [checkStart-checkEnd]: [${checkStart}-${checkEnd}] (${expr.type === 'interpolation' ? 'Exclusive End' : 'Inclusive End'})`);
            log('debug', `  - Check Result (isWithinRange): ${isWithinRange}`);

            if (isWithinRange) {
                activeMapping = docInfo.mappings.find(m =>
                    m.htmlExpressionLocation.startOffset === expr.htmlLocation.startOffset &&
                    m.htmlExpressionLocation.endOffset === expr.htmlLocation.endOffset &&
                    m.type === expr.type
                );
                if (activeMapping) {
                    log('debug', `    - Offset ${offset} IS within range of fresh expression [${mapStart}-${mapEnd}]. Found matching original mapping.`);
                    break;
                } else {
                    log('warn', `    - Offset ${offset} IS within range of fresh expression [${mapStart}-${mapEnd}], BUT could not find matching original mapping! Proceeding without expression context.`);
                }
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
            let provideNewAttributeCompletions = false;

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
                if (!isInsideAttributeName) {
                    provideNewAttributeCompletions = true;
                }
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
                    // Get component info IF available, but don't require it for suffix logic
                    const componentInfo = aureliaProjectComponents.get(tagNameFromRegex);

                    // Logic to find the word before the dot
                    const textEndingBeforeDot = document.getText(LSPRange.create(Position.create(0, 0), document.positionAt(offset - 1)));
                    const wordMatch = textEndingBeforeDot.match(/([a-zA-Z0-9_-]+)$/);
                    const wordBeforeDot = wordMatch ? wordMatch[1] : '';
                    log('debug', `  - Word before dot: '${wordBeforeDot}'`);

                    if (wordBeforeDot) {
                        // Check if it's a known bindable for this specific component (if it is a component)
                        const isKnownBindable = componentInfo?.type === 'element' && (componentInfo.bindables?.some(b => b.propertyName === wordBeforeDot) ?? false);
                        // Check if it looks like a valid attribute name generally
                        const isValidAttributeName = /^[a-zA-Z][a-zA-Z0-9-]*$/.test(wordBeforeDot);

                        // Provide suffixes if it's a known bindable OR a valid attribute name pattern
                        if (isKnownBindable || isValidAttributeName) {
                            const detailContext = isKnownBindable ? `bindable property '${wordBeforeDot}'` : `attribute '${wordBeforeDot}'`;
                            log('debug', `  - Word matches criteria (${isKnownBindable ? 'bindable' : 'valid attribute name'}): ${wordBeforeDot}. Providing suffix completions.`);

                            AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                                if (suffix !== '.ref') { // Skip .ref
                                    htmlCompletions.push({
                                        label: suffix.substring(1), // Suggest 'bind', 'one-way' etc.
                                        kind: CompletionItemKind.Event,
                                        insertText: suffix.substring(1), // Insert just the command part
                                        insertTextFormat: InsertTextFormat.PlainText,
                                        detail: `Aurelia command ${suffix} on ${detailContext}`,
                                        filterText: `${wordBeforeDot}${suffix}`,
                                        sortText: `0_${isKnownBindable ? 'bindable' : 'attribute'}_${wordBeforeDot}${suffix}`
                                    });
                                }
                            });

                            // Return *only* these suffix completions
                            const distinctMap = new Map<string, CompletionItem>();
                            htmlCompletions.forEach(item => { if (!distinctMap.has(item.label)) { distinctMap.set(item.label, item); } });
                            const distinctCompletions = Array.from(distinctMap.values());
                            log('debug', `[onCompletion] HTML Context (Dot Trigger for ${detailContext}): Returning ${distinctCompletions.length} distinct command completions.`);
                            return distinctCompletions;
                        }
                        // else: Dot was after a word, but it wasn't a known bindable or valid attribute name pattern.
                        // In this case, we don't want to provide suffix completions.
                        log('debug', `  - Word '${wordBeforeDot}' before dot is not a known bindable or valid attribute name pattern. No suffix completions.`);
                    }
                    else {
                        // else: Dot was likely typed immediately after opening tag or in whitespace, not after an attribute word.
                        log('debug', `  - No valid word character found immediately before the dot. No suffix completions.`);
                    }
                }
                // If we reach here, it means either:
                // - No preceding tag was found
                // - A tag was found, but the dot wasn't immediately after a known bindable or valid attribute name.
                // In these cases, we should not return any completions from this dot-trigger logic.
                log('debug', `[onCompletion] Dot trigger logic finished without providing attribute suffix completions. No further HTML completions from this branch.`);
                return undefined; // Explicitly return no completions for this trigger path
            }
            else if (!provideAttributeCompletions && !provideElementCompletions && (charBeforeCursor === ' ' || triggerChar === undefined)) {
                const textBeforeOffset = document.getText(LSPRange.create(Position.create(0, 0), params.position));

                // Find the last opening bracket before the cursor
                const lastBracketIndex = textBeforeOffset.lastIndexOf('<');

                if (lastBracketIndex !== -1) {
                    // Extract the text from the last bracket to the cursor
                    const potentialTagStart = textBeforeOffset.substring(lastBracketIndex);

                    // CORRECTED Regex: Check if substring STARTS with <tag-name followed by a space.
                    // Removed the '+' and the '$' end anchor.
                    const tagMatch = potentialTagStart.match(/^<([a-zA-Z0-9-]+)\s/);

                    if (tagMatch) {
                        const tagNameFromRegex = tagMatch[1];
                        log('debug', `[onCompletion] HTML Context: Triggering NEW attribute completions based on refined fallback check (substring=\'${potentialTagStart}\'). Tag found: ${tagNameFromRegex}`);
                        provideNewAttributeCompletions = true;
                        provideAttributeCompletions = true; // Keep setting this for now
                        currentTagName = tagNameFromRegex;
                    } else {
                        // Update log message to reflect the new regex pattern
                        log('debug', `[onCompletion] HTML Context: Refined fallback check: Substring '${potentialTagStart}' did not match /^<([a-zA-Z0-9-]+)\\s/`);
                    }
                } else {
                    log('debug', `[onCompletion] HTML Context: Refined fallback check: No '<' found before cursor.`);
                }
            }

            log('debug', `[onCompletion] HTML Context Flags: provideElements=${provideElementCompletions}, provideAttributes=${provideAttributeCompletions}, provideNewAttributes=${provideNewAttributeCompletions}, currentTagName=${currentTagName}`);

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

            if (provideNewAttributeCompletions) {
                log('debug', `[onCompletion] Providing NEW Attribute/Bindable completions. Project components count: ${aureliaProjectComponents.size}`);
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

                // Bindables for the current tag
                if (currentTagName) {
                    const componentInfo = aureliaProjectComponents.get(currentTagName);
                    if (componentInfo?.type === 'element' && componentInfo.bindables && Array.isArray(componentInfo.bindables)) {
                        log('debug', `[onCompletion] Found element <${currentTagName}> with bindables: ${componentInfo.bindables.map(b => b.propertyName).join(', ')}`);
                        componentInfo.bindables.forEach(bindableInfo => {
                            // Determine the attribute name to suggest
                            const attributeNameToSuggest = bindableInfo.attributeName ?? toKebabCase(bindableInfo.propertyName);

                            // Suggest the base attribute name
                            htmlCompletions.push({
                                label: attributeNameToSuggest,
                                kind: CompletionItemKind.Property,
                                insertText: `${attributeNameToSuggest}="$1"`,
                                insertTextFormat: InsertTextFormat.Snippet,
                                detail: `Bindable property '${bindableInfo.propertyName}' for <${currentTagName}>`,
                                sortText: `0_bindable_${attributeNameToSuggest}`
                            });

                            // Suggest suffixed versions (.bind, .one-way, etc.)
                            AURELIA_BINDING_SUFFIXES.forEach(suffix => {
                                if (suffix !== '.ref') {
                                    htmlCompletions.push({
                                        label: `${attributeNameToSuggest}${suffix}`,
                                        kind: CompletionItemKind.Event,
                                        insertText: `${attributeNameToSuggest}${suffix}="\${1:expression}"`,
                                        insertTextFormat: InsertTextFormat.Snippet,
                                        detail: `Bind ${suffix} on '${bindableInfo.propertyName}'`,
                                        sortText: `0_bindable_${attributeNameToSuggest}${suffix}`
                                    });
                                }
                            });
                        });
                    } else {
                        log('debug', `[onCompletion] Current tag <${currentTagName}> not found as element or has no bindables.`);
                    }
                } else {
                    log('debug', '[onCompletion] No current tag name identified for bindable completions.');
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
        const memberNames = getViewModelMemberNames(docInfo.vmClassName, docInfo.vmFsPath, languageService, viewModelMembersCache, program);

        let virtualCompletionOffset = mapHtmlOffsetToVirtual(offset, activeMapping);

        log('debug', `[onCompletion] Expression context. Mapped HTML Offset ${offset} to Virtual Offset ${virtualCompletionOffset} (initial)`);

        // <<< Force offset for EMPTY interpolations >>>
        if (activeMapping.type === 'interpolation' &&
            activeMapping.htmlExpressionLocation.startOffset === activeMapping.htmlExpressionLocation.endOffset &&
            virtualCompletionOffset < activeMapping.virtualValueRange.end) { // Ensure not already at/past end

            const forcedOffset = activeMapping.virtualValueRange.start + 1;
            log('debug', `[onCompletion] Empty interpolation detected. Forcing virtual offset from ${virtualCompletionOffset} to ${forcedOffset}`);
            virtualCompletionOffset = forcedOffset;
        }
        // <<< End Force Offset >>>

        // Original dot trigger logic (might need refinement later if the above works)
        if (offset === activeMapping.htmlExpressionLocation.endOffset + 1 && params.context?.triggerCharacter === '.') {
            virtualCompletionOffset = activeMapping.virtualValueRange.end;
        }
        log('debug', `[onCompletion] Expression context. Mapped HTML Offset ${offset} to Virtual Offset ${virtualCompletionOffset}`);

        const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
        let completions: ts.WithMetadata<ts.CompletionInfo> | undefined;
        try {
            // +++ Log context before calling TS (Safer checks) +++
            log('debug', `[onCompletion] Attempting TS completions for virtual URI: ${docInfo.virtualUri}`);
            if (docInfo.virtualUri && virtualFiles.has(docInfo.virtualUri)) {
                const virtualDocEntry = virtualFiles.get(docInfo.virtualUri);
                if (virtualDocEntry) {
                    const virtualDocContent = virtualDocEntry.content;
                    const snippetStart = Math.max(0, virtualCompletionOffset - 10);
                    const snippetEnd = Math.min(virtualDocContent.length, virtualCompletionOffset + 10);
                    const virtualSnippet = virtualDocContent.substring(snippetStart, snippetEnd).replace(/\n/g, '\\n');
                    const cursorMarker = '|';
                    const markedSnippet = virtualSnippet.substring(0, virtualCompletionOffset - snippetStart) + cursorMarker + virtualSnippet.substring(virtualCompletionOffset - snippetStart);
                    log('debug', `[onCompletion] Calling TS completions at: ${virtualFsPath}:${virtualCompletionOffset}`);
                    log('debug', `[onCompletion] Virtual context around offset: "...${markedSnippet}..."`);
                } else {
                    log('warn', `[onCompletion] virtualFiles map has URI ${docInfo.virtualUri} but entry is missing?`);
                }
            } else {
                log('warn', `[onCompletion] Cannot get virtual context: virtualUri is missing or not in virtualFiles map. virtualUri: ${docInfo.virtualUri}, Has Key: ${virtualFiles.has(docInfo.virtualUri ?? '')}`);
            }
            // +++ End log context +++

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
        const lastTwo = textBeforeCursor[textBeforeCursor.length - 2]?.trim();

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

        if (lastTwo === '|' || lastTwo === '' && charBeforeCursor === '|') {
            expressionCompletions = [];
            log('debug', `[onCompletion] Pipe trigger detected. Offering Value Converters.`);
            aureliaProjectComponents.forEach((component) => {
                if (component.type === 'valueConverter') {
                    log('debug', `  - Adding VC completion: ${component.name}`);
                    expressionCompletions.push({
                        label: component.name,
                        kind: CompletionItemKind.Function, // Treat VCs like functions
                        insertText: component.name,
                        sortText: '1_vc_' + component.name, // Sort VCs after VM members
                        detail: 'Value Converter',
                        documentation: component.uri ? `Defined in: ${path.basename(URI.parse(component.uri).fsPath)}` : undefined
                    });
                }
            });
        } else {
            const converters: string[] = [];
            aureliaProjectComponents.forEach((component) => {
                if (component.type === 'valueConverter') {
                    converters.push(component.name);
                }
            });

            expressionCompletions = expressionCompletions.filter(c => !converters.includes(c.label));
            log('debug', `[onCompletion] Filtered out ${expressionCompletions.length} VCs from completions.`);
        }
        // <<< End Value Converter Completions >>>

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