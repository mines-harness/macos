import type { SVGProps } from "react";

export function MinesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M12 10h8v2h2v8h-2v2h-8v-2h-2v-8h2zM15 5h2v22h-2zM5 15h22v2H5zM7 7h3v3H7zm15 15h3v3h-3zM22 7h3v3h-3zM7 22h3v3H7z" />
    </svg>
  );
}

export function MinesWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 178 40" xmlns="http://www.w3.org/2000/svg">
      <g fill="currentColor">
        <path d="M17 4h6v6h5v5h6v6h-6v5h-5v6h-6v-6h-5v-5H6v-6h6v-5h5z" />
        <path d="m9 7 4 4-4 4-4-4zm22 0 4 4-4 4-4-4zM9 25l4 4-4 4-4-4zm22 0 4 4-4 4-4-4z" />
      </g>
      <rect x="15" y="12" width="4" height="4" rx="1" fill="var(--background, #000)" />
      <text
        x="45"
        y="31"
        fill="currentColor"
        fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
        fontSize="34"
        fontWeight="650"
        letterSpacing="-1.5"
      >
        mines
      </text>
    </svg>
  );
}
