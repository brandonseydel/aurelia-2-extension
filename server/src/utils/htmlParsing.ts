// Statically import types needed
import type { EndTag, StartTag } from 'parse5-sax-parser' assert { "resolution-mode": "import" };
import { DefaultTreeAdapterTypes } from 'parse5';
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