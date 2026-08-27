/**
 * React transcript renderers (layer 3).
 *
 * Imported as `@zclaudia/agent-transcript-kit/react`, kept off the root entry
 * so consumers of layers 1–2 stay free of a React dependency. Pair with the
 * stylesheet: `import '@zclaudia/agent-transcript-kit/transcript.css'`.
 */

export {
  TranscriptCapabilitiesProvider,
  useTranscriptCapabilities,
  type TranscriptCapabilities,
} from './capabilities.js';
export { CodeBlock, SHELL_LANGUAGES, type CodeBlockProps } from './CodeBlock.js';
export { ToolCallCard, type ToolCallCardProps } from './ToolCallCard.js';
export {
  ThinkingBlock,
  type ThinkingBlockProps,
  type ThinkingSegment,
} from './ThinkingBlock.js';
