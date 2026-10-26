import { useRef, useState, type ReactNode } from "react";
import { Menu, MenuPopup } from "../ui/menu";

export function CatalogRowMenu({
  title,
  children,
  menu,
}: {
  title: string;
  children: ReactNode;
  menu: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openContextMenu = (target: EventTarget | null, x: number, y: number) => {
    returnFocus.current =
      target instanceof Element ? target.closest<HTMLElement>("button, [tabindex]") : null;
    returnFocus.current?.focus();
    setPoint({ x, y });
    setOpen(true);
  };
  return (
    <Menu
      open={open}
      onOpenChange={(next, details) => {
        if (next && details.reason === "trigger-press") setPoint(null);
        setOpen(next);
      }}
    >
      <div
        className="group/catalog-menu contents select-none"
        data-catalog-menu-open={open || undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openContextMenu(event.target, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = (event.target as HTMLElement).getBoundingClientRect();
          openContextMenu(event.target, rect.left, rect.bottom);
        }}
      >
        {children}
        <MenuPopup
          align={point ? "start" : "end"}
          sideOffset={point ? 0 : 4}
          anchor={
            point ? { getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) } : undefined
          }
          finalFocus={point ? returnFocus : undefined}
          aria-label={`Actions for ${title}`}
        >
          {menu}
        </MenuPopup>
      </div>
    </Menu>
  );
}
