// Statically import types needed
import type { EndTag, StartTag } from 'parse5-sax-parser' assert { "resolution-mode": "import" };
import { DefaultTreeAdapterTypes } from 'parse5';
import * as parse5 from 'parse5';
import { log } from '../utils/logger';
import { Location } from '../common/types'; // Use our Location type
import { calculateLocationFromOffset } from '../utils/utilities'; // <<< Add import
/** Information about an HTML tag found at a specific offset */
export interface TagInfo {
    tagName: string;
    /** Whether the offset is within the start tag or end tag */
    type: 'start' | 'end';
     /** The parse5 element node (partially populated for tag context) */
     node: Partial<DefaultTreeAdapterTypes.Element>; // Use Partial<Element> as node is incomplete
     /** Raw location info from parser */
     locations?: DefaultTreeAdapterTypes.Element['sourceCodeLocation'] | null; // Use directly imported type
}

/**
 * Uses parse5-sax-parser to find if the given offset is inside an HTML tag's name.
 * Returns the tag name and type ('start' or 'end') if found.
 * Made async to support dynamic import of ESM module.
 */
export async function getTagAtOffset(html: string, offset: number): Promise<TagInfo | undefined> { // Return Promise
    let foundTagInfo: TagInfo | undefined = undefined;

    try {
        // Dynamically import only the SAXParser class
        const { SAXParser } = await import('parse5-sax-parser');
        const parser = new SAXParser({ sourceCodeLocationInfo: true });

        // Use statically imported types
        parser.on('startTag', (token: StartTag) => {
            const loc = token.sourceCodeLocation;
            if (loc && offset > loc.startOffset && offset <= loc.endOffset) {
                const tagNameStartOffset = loc.startOffset + 1; // Skip '<'
                const tagNameEndOffset = tagNameStartOffset + token.tagName.length;
                if (offset >= tagNameStartOffset && offset <= tagNameEndOffset) {
                    foundTagInfo = {
                        tagName: token.tagName,
                        type: 'start',
                        locations: loc,
                        node: { tagName: token.tagName, attrs: token.attrs } as Partial<DefaultTreeAdapterTypes.Element>
                    };
                    parser.stop();
                }
            }
        });

        // Use statically imported types
        parser.on('endTag', (token: EndTag) => {
            const loc = token.sourceCodeLocation;
            if (loc && offset > loc.startOffset && offset <= loc.endOffset) {
                const tagNameStartOffset = loc.startOffset + 2; // Skip '</'
                const tagNameEndOffset = tagNameStartOffset + token.tagName.length;
                if (offset >= tagNameStartOffset && offset <= tagNameEndOffset) {
                    foundTagInfo = {
                        tagName: token.tagName,
                        type: 'end',
                        locations: loc,
                        node: { tagName: token.tagName } as Partial<DefaultTreeAdapterTypes.Element>
                    };
                    parser.stop();
                }
            }
        });

        parser.write(html);
        parser.end();

    } catch (e: any) {
        console.error(`[htmlParsing] Error importing or using SAXParser: ${e?.message || e}`);
        return undefined;
    }

    return foundTagInfo;
}

// +++ Revised Helper Function +++
/**
 * Finds the attribute name and its containing tag at a given offset in HTML content.
 * Uses getTagAtOffset and regex parsing within the tag.
 */
export async function getAttributeNameAtOffset(
    htmlContent: string, 
    targetOffset: number
): Promise<{ tagName: string; attributeName: string; location: Location } | undefined> {
    try {
        const tagInfo = await getTagAtOffset(htmlContent, targetOffset);

        // If no tag info, or not a start tag, or location/startTag missing, exit
        if (!tagInfo || tagInfo.type !== 'start' || !tagInfo.locations?.startTag) {
            log('debug', `[getAttributeNameAtOffset] Exiting: No start tag info found for offset ${targetOffset}.`);
            return undefined;
        }
        
        const startTagLoc = tagInfo.locations.startTag; 
        const tagNameEndOffset = startTagLoc.startOffset + tagInfo.tagName.length + 1; // Offset after <tagName

        // If offset is inside the tag name itself, or before the tag content starts, it's not an attribute name
        if (targetOffset <= tagNameEndOffset) { 
            log('debug', `[getAttributeNameAtOffset] Exiting: Offset ${targetOffset} is within tag name '${tagInfo.tagName}' or before attributes.`);
            return undefined; 
        }
        // If offset is outside the start tag completely
        if (targetOffset >= startTagLoc.endOffset) {
             log('debug', `[getAttributeNameAtOffset] Exiting: Offset ${targetOffset} is after start tag ends at ${startTagLoc.endOffset}.`);
            return undefined;
        }

        // Offset is now guaranteed to be within the attribute area of the start tag
        const startTagContent = htmlContent.substring(startTagLoc.startOffset, startTagLoc.endOffset);
        // Regex: Find attribute name (group 1). Handles valueless attrs too.
        const attrRegex = /\s+([a-zA-Z0-9:._-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"'=]+))?/g;
        let match;
        
        log('debug', `[getAttributeNameAtOffset] Analyzing tag content for offset ${targetOffset}: ${startTagContent}`);

        while ((match = attrRegex.exec(startTagContent)) !== null) {
            const attributeName = match[1];
            const matchStartIndexInTag = match.index; // Index relative to startTagContent where the match begins (includes leading space)
            
            // Find the start index of the name itself within the match
            const nameIndexInMatch = match[0].indexOf(attributeName);
            const nameStartIndexInTag = matchStartIndexInTag + nameIndexInMatch; // Index relative to startTagContent
            
            // Calculate absolute start/end offsets for the attribute NAME
            const nameStartOffset = startTagLoc.startOffset + nameStartIndexInTag;
            const nameEndOffset = nameStartOffset + attributeName.length;

            log('debug', `  - Found attribute pattern: ${match[0]} -> Name: ${attributeName} at [${nameStartOffset}-${nameEndOffset}]`);

            // Check if the target offset falls within this attribute name's range
            if (targetOffset >= nameStartOffset && targetOffset <= nameEndOffset) {
                log('debug', `    -> Match! Offset ${targetOffset} is within attribute name '${attributeName}'`);
                const startLoc = calculateLocationFromOffset(htmlContent, nameStartOffset);
                const endLoc = calculateLocationFromOffset(htmlContent, nameEndOffset);
                if (startLoc && endLoc) {
                    return {
                        tagName: tagInfo.tagName,
                        attributeName: attributeName,
                        location: { 
                            startOffset: nameStartOffset,
                            endOffset: nameEndOffset,
                            startLine: startLoc.line,
                            startCol: startLoc.col,
                            endLine: endLoc.line,
                            endCol: endLoc.col
                        }
                    };
                } else {
                    log('warn', `[getAttributeNameAtOffset] Could not calculate location for attribute '${attributeName}'`);
                    return undefined; // Exit if location calculation fails
                }
            } else {
                 log('debug', `    -> No match for offset ${targetOffset}.`);
            }
        }

        log('debug', '[getAttributeNameAtOffset] Finished regex loop, no matching attribute name found for offset.');
        return undefined;

    } catch (error) {
        log('error', `[getAttributeNameAtOffset] Error processing HTML: ${error}`);
        return undefined;
    }
} 