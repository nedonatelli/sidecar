# Tree-Sitter Integration

SideCar now supports tree-sitter integration for enhanced code analysis and context selection. This feature allows the extension to understand code structure at a deeper level, enabling more intelligent code suggestions and context-aware responses.

## What is Tree-Sitter?

Tree-sitter is a parser generator tool and an incremental parsing library that builds a concrete syntax tree for a source file. It provides a much more accurate understanding of code structure compared to simple regex-based parsing.

## Current Implementation

While the full tree-sitter integration requires native compilation which can be challenging in VS Code extensions, SideCar implements a lightweight AST-based context selection system that:

1. **Parses code elements** (functions, classes, methods) from source files
2. **Scores elements** based on relevance to user queries
3. **Extracts smart context** by identifying the most relevant code portions

## Benefits

- **Improved context selection**: The system can now identify relevant code elements like functions, classes, and methods based on query terms
- **Enhanced code understanding**: Better understanding of code structure leads to more accurate responses
- **Reduced noise**: Only relevant code portions are included in the context window

## How It Works

When you ask SideCar about code, it now:

1. Analyzes the workspace files using lightweight parsing
2. Identifies code elements that match your query terms
3. Extracts the most relevant code portions to include in the context
4. Presents this enhanced context to the LLM for better understanding

## Configuration

Tree-sitter integration is enabled by default. No additional configuration is required.

## Future Enhancements

In future versions, SideCar will support full tree-sitter integration with:

- More accurate parsing for all supported languages
- Better code element identification
- Enhanced context-awareness for complex code structures
- Improved performance through optimized parsing

## Example

When you ask "How does the user processing function work?", SideCar will now:

1. Parse all relevant files
2. Identify functions named "processUser", "handleUser", etc.
3. Extract the relevant function definitions and surrounding context
4. Present this focused context to the LLM

This results in much more accurate and helpful responses compared to traditional file-based context selection.