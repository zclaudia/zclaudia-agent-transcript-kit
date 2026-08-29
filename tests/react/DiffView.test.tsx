import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView } from '../../src/react/index.js';

describe('DiffView', () => {
  it('computes a diff from two revisions and counts the change', () => {
    render(<DiffView oldText={'a\nb\nc'} newText={'a\nx\nc'} filePath="/src/thing.ts" />);
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    // The header names the file, not its whole path — the path is the tooltip.
    expect(screen.getByText('thing.ts')).toBeInTheDocument();
  });

  it('parses a diff the agent already rendered rather than recomputing it', () => {
    const unified = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');
    render(<DiffView unified={unified} />);
    // The path comes from the diff's own header when none is passed.
    expect(screen.getByText('x.ts')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('omits a count that would read as zero', () => {
    render(<DiffView oldText="a" newText={'a\nb'} />);
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.queryByText('-0')).not.toBeInTheDocument();
  });
});
