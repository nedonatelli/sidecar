export interface EditBlock {
  filePath: string;
  searchText: string;
  replaceText: string;
}

const EDIT_BLOCK_REGEX = /<<<SEARCH:([^\n]+)\n([\s\S]*?)\n===\n([\s\S]*?)\n>>>REPLACE/g;

export function parseEditBlocks(text: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  let match;

  while ((match = EDIT_BLOCK_REGEX.exec(text)) !== null) {
    blocks.push({
      filePath: match[1].trim(),
      searchText: match[2],
      replaceText: match[3],
    });
  }

  return blocks;
}
