/**
 * The three glyphs the renderers need, inlined.
 *
 * An icon library would be a third runtime dependency for two chevrons and a
 * checkmark, and every host already ships its own set — pulling lucide (or
 * any other) in would duplicate it. These are the lucide outlines the hosts
 * were already using, so the visual stays identical.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps({ size = 16, className }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}

export function TerminalIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
