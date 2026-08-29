import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThinkingBlock } from '../../src/react/index.js';

describe('ThinkingBlock', () => {
  it('counts lines for text and blocks for structured segments', () => {
    // Lines and blocks are different facts about how much reasoning there is;
    // the label says which one it is counting.
    const { rerender } = render(<ThinkingBlock content={'one\n\ntwo\nthree'} />);
    expect(screen.getByText('3 lines')).toBeInTheDocument();

    rerender(<ThinkingBlock content={[{ text: 'a' }, { text: 'b' }]} />);
    expect(screen.getByText('2 blocks')).toBeInTheDocument();

    rerender(<ThinkingBlock content="only one" />);
    expect(screen.getByText('1 line')).toBeInTheDocument();
  });

  it('previews the first lines while collapsed and shows everything when open', () => {
    render(<ThinkingBlock content={'first\nsecond\nthird'} />);
    const preview = screen.getByText(/first/);
    expect(preview.textContent).toContain('second');
    // The third line is beyond the preview, so it is only teased.
    expect(preview.textContent).not.toContain('third');
    expect(preview.textContent).toContain('...');

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/third/)).toBeInTheDocument();
  });

  it('says when a provider withheld a segment', () => {
    render(<ThinkingBlock content={[{ text: 'kept' }, { text: '', redacted: true }]} />);
    fireEvent.click(screen.getByRole('button'));
    // Withheld reasoning is reported, not silently dropped — a gap the reader
    // cannot see is worse than one they can.
    expect(screen.getByText('[Redacted by safety filter]')).toBeInTheDocument();
  });

  it('renders nothing when there is no reasoning to show', () => {
    const { container } = render(<ThinkingBlock content={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
