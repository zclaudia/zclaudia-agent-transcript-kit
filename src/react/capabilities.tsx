import { createContext, useContext, type ReactNode } from 'react';

/**
 * Host capabilities for the transcript renderers.
 *
 * Renderers deep inside a markdown component map cannot be reached by props,
 * so capabilities travel by context. Everything is optional and gated on
 * presence: a host that cannot paste into a terminal simply omits
 * `runInTerminal` and no button renders.
 *
 * This is deliberately NOT a place for host state. It carries only what the
 * kit cannot do for itself — actions that touch the host application, and
 * rendering the host has an opinion about (syntax highlighting).
 */
export interface TranscriptCapabilities {
  /** Paste a command/snippet into the host's terminal. */
  runInTerminal?: (command: string) => void;

  /**
   * Syntax-highlight a code string. The kit ships no highlighter: hosts differ
   * (Prism, highlight.js, none at all) and bundling one would force a second
   * copy on every host that already has it. Return `undefined` to fall back to
   * plain text.
   *
   * Implementations should emit Prism-style token classes (`token keyword`,
   * `token string`, …) so the kit stylesheet colors them from the theme.
   */
  highlightCode?: (code: string, language: string) => ReactNode | undefined;

  /**
   * Icon for a tool, by tool name. Hosts keep their own icon sets and mappings
   * (and their own icon component), so the kit renders whatever comes back and
   * falls back to a generic glyph when this is absent or returns nothing.
   */
  toolIcon?: (toolName: string) => ReactNode | undefined;

  /**
   * Render markdown — a plan under review is written in it. Same reasoning as
   * the highlighter: hosts already have a renderer configured with their own
   * plugins and link handling, and a second one would disagree with the first.
   * Without it the text renders as-is.
   */
  renderMarkdown?: (text: string) => ReactNode | undefined;
}

const TranscriptCapabilitiesContext = createContext<TranscriptCapabilities>({});

export const TranscriptCapabilitiesProvider = TranscriptCapabilitiesContext.Provider;

export function useTranscriptCapabilities(): TranscriptCapabilities {
  return useContext(TranscriptCapabilitiesContext);
}
