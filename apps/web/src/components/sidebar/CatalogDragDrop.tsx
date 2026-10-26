import { RegistryContext } from "@effect/atom-react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
} from "@dnd-kit/core";
import { minesAccountIdAtom, type MinesCatalog } from "@t3tools/client-runtime/catalog";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import {
  catalogDropAllowed,
  commitCatalogDrop,
  type CatalogDragSource,
  type CatalogDropTarget,
} from "./MinesCatalogTree.drag";

const DragState = createContext<{
  accountId: string;
  entityId: string | null;
  allowed: (target: CatalogDropTarget) => boolean;
} | null>(null);

const collisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin({
    ...args,
    pointerCoordinates: args.pointerCoordinates ?? {
      x: args.collisionRect.left + args.collisionRect.width / 2,
      y: args.collisionRect.top + args.collisionRect.height / 2,
    },
  });
  if (collisions.length === 0 && !args.pointerCoordinates) return closestCenter(args);
  return collisions
    .sort((a, b) => {
      const left = args.droppableRects.get(a.id);
      const right = args.droppableRects.get(b.id);
      return (
        (left ? left.width * left.height : Infinity) -
        (right ? right.width * right.height : Infinity)
      );
    })
    .slice(0, 1);
};

export function CatalogDragProvider({
  catalog,
  accountId,
  onError,
  children,
}: {
  catalog: MinesCatalog;
  accountId: string;
  onError: (message: string | null) => void;
  children: ReactNode;
}) {
  const registry = useContext(RegistryContext);
  const [drag, setDrag] = useState<{
    source: CatalogDragSource;
    catalog: MinesCatalog;
    title: string;
  } | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const allowed = (target: CatalogDropTarget) =>
    drag !== null &&
    drag.catalog === catalog &&
    drag.source.accountId === accountId &&
    drag.source.accountId === (registry.get(minesAccountIdAtom) ?? "local-device") &&
    catalogDropAllowed(catalog.getSnapshot(), drag.source.entityId, target);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "To move an item, press Space, use the arrow keys, and press Space to drop. Press Escape to cancel. The Arrange menu also offers Move up, Move down, Move to, and Pin.",
        },
        announcements: {
          onDragStart: () =>
            "Item picked up. Move between rows to reorder, onto a section or project to move inside, or into Pinned to pin.",
          onDragOver: ({ over }) =>
            over
              ? `Drop target: ${over.data.current?.label ?? "Library"}.`
              : "Outside the library. Release to cancel.",
          onDragEnd: ({ over }) =>
            over && over.data.current?.target && allowed(over.data.current.target)
              ? "Move finished."
              : "Move cancelled.",
          onDragCancel: () => "Move cancelled.",
        },
      }}
      onDragStart={({ active }) => {
        const source = active.data.current?.source as CatalogDragSource | undefined;
        if (!source || source.accountId !== (registry.get(minesAccountIdAtom) ?? "local-device"))
          return;
        const entity = catalog
          .getSnapshot()
          .entities.find((candidate) => candidate.id === source.entityId);
        if (entity) {
          setDrag({ source, catalog, title: entity.title });
          onError(null);
        }
      }}
      onDragCancel={() => setDrag(null)}
      onDragEnd={({ over }) => {
        try {
          const target = over?.data.current?.target as CatalogDropTarget | undefined;
          if (drag && target) {
            if (drag.catalog !== catalog)
              throw new Error("Your library changed. Start this move again.");
            commitCatalogDrop(
              catalog,
              drag.source,
              target,
              registry.get(minesAccountIdAtom) ?? "local-device",
            );
            onError(null);
          }
        } catch (cause) {
          onError(cause instanceof Error ? cause.message : "Could not move this item.");
        } finally {
          setDrag(null);
        }
      }}
    >
      <DragState value={{ accountId, entityId: drag?.source.entityId ?? null, allowed }}>
        {children}
      </DragState>
      <DragOverlay dropAnimation={null}>
        {drag ? (
          <div className="flex w-60 items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar p-2 text-sm text-sidebar-foreground shadow-lg">
            <span className="truncate">{drag.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export function CatalogDraggableRow({
  rowId,
  entityId,
  title,
  children,
  className,
  disabled,
  onClick,
  onMouseDown,
  onTouchStart,
  onKeyDown,
  ...props
}: {
  rowId: string;
  entityId: string;
  title: string;
} & ComponentPropsWithoutRef<"button">) {
  const state = useContext(DragState);
  const suppressClick = useRef(false);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: `drag:${rowId}`,
    data: { source: { entityId, accountId: state?.accountId ?? "" } },
    disabled: disabled ?? false,
  });
  useEffect(() => {
    if (isDragging) suppressClick.current = true;
  }, [isDragging]);
  return (
    <button
      type="button"
      ref={(node) => {
        setNodeRef(node);
        setActivatorNodeRef(node);
      }}
      {...attributes}
      {...listeners}
      aria-label={title}
      {...props}
      disabled={disabled}
      onMouseDown={(event) => {
        if (!isDragging) suppressClick.current = false;
        onMouseDown?.(event);
        if (!event.defaultPrevented) listeners?.onMouseDown?.(event);
      }}
      onTouchStart={(event) => {
        if (!isDragging) suppressClick.current = false;
        onTouchStart?.(event);
        if (!event.defaultPrevented) listeners?.onTouchStart?.(event);
      }}
      onKeyDown={(event) => {
        if (!isDragging) suppressClick.current = false;
        onKeyDown?.(event);
        if (!event.defaultPrevented) listeners?.onKeyDown?.(event);
      }}
      onClick={(event) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
          return;
        }
        onClick?.(event);
      }}
      className={cn(
        "touch-pan-y cursor-grab active:cursor-grabbing",
        className,
        isDragging && "opacity-40",
      )}
    >
      {children}
    </button>
  );
}

export function CatalogDropArea({
  id,
  target,
  label,
  children,
  className,
  style,
}: {
  id: string;
  target: CatalogDropTarget;
  label: string;
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const state = useContext(DragState);
  const { setNodeRef, isOver } = useDroppable({ id: `drop:${id}`, data: { target, label } });
  const allowed = isOver && (state?.allowed(target) ?? false);
  return (
    <div
      ref={setNodeRef}
      data-catalog-drop={id}
      data-catalog-drop-state={
        isOver && state?.entityId ? (allowed ? "allowed" : "blocked") : undefined
      }
      className={cn(
        className,
        isOver &&
          state?.entityId &&
          (allowed
            ? "bg-primary/10 ring-1 ring-inset ring-primary/50"
            : "bg-destructive/10 ring-1 ring-inset ring-destructive/40"),
      )}
      style={style}
    >
      {children}
    </div>
  );
}

export function CatalogDropLine({
  id,
  target,
  label,
}: {
  id: string;
  target: CatalogDropTarget;
  label: string;
}) {
  const state = useContext(DragState);
  const { setNodeRef, isOver } = useDroppable({ id: `drop:${id}`, data: { target, label } });
  const allowed = isOver && (state?.allowed(target) ?? false);
  return (
    <div
      ref={setNodeRef}
      data-catalog-drop={id}
      data-catalog-drop-state={
        isOver && state?.entityId ? (allowed ? "allowed" : "blocked") : undefined
      }
      className="relative h-2"
      aria-hidden
    >
      <span
        className={cn(
          "absolute inset-x-1 top-1/2 h-0.5 rounded",
          isOver && state?.entityId && (allowed ? "bg-primary" : "bg-destructive"),
        )}
      />
    </div>
  );
}
