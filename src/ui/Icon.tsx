const paths: Record<string, string> = {
  folder: "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  file: "M4 2.5h5l3 3v8a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5zM9 2.5v3h3",
  lambda: "M4 3h2.2l6 11M8.1 8.2 4.5 14",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5",
  download: "M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10",
  play: "M5 3.2v9.6L12.5 8z",
  check: "M3 8.5 6.5 12 13 4.5",
  hammer: "M9.5 3.5 12.5 6.5 11 8 8 5zM8.8 6.2 3 12l1 1 5.8-5.8",
  stop: "M4 4h8v8H4z",
  x: "M4 4l8 8M12 4l-8 8",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v3.5M9 7v3.5",
  back: "M10 3 5 8l5 5",
  forward: "M6 3l5 5-5 5",
  search: "M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zM10.6 10.6 14 14",
  bug: "M5.5 6.5a2.5 2.5 0 0 1 5 0V10a2.5 2.5 0 0 1-5 0zM8 6.5V13M3 8h2.5M10.5 8H13M3.5 4.5l2 1.5M12.5 4.5l-2 1.5M3.5 12.5l2-1.5M12.5 12.5l-2-1.5",
  sparkle: "M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z",
  terminal: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h3",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  gear: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  plus: "M8 3v10M3 8h10",
  lock: "M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2",
  history: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5",
  stepInto: "M8 2.5v7M5 6.5l3 3 3-3M5 13.5h6",
  stepOver: "M3 9a5 5 0 0 1 9.5-2M12.5 3.5V7H9M8 12.5h.01",
  stepOut: "M8 10V3M5 6l3-3 3 3M5 13.5h6",
  restart: "M3 8a5 5 0 1 0 1.5-3.6M3 2.5V5h2.5",
  upgrade: "M8 13V4M4.5 7.5 8 4l3.5 3.5M3.5 2.5h9",
};

export function Icon({ name, size = 14 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name] ?? paths.file} fill={name === "play" ? "currentColor" : "none"} />
    </svg>
  );
}
