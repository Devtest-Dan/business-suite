"use client";

import Link from "next/link";
import { useState, useTransition, type DragEvent } from "react";
import { moveTaskAction } from "../actions";
import type { TaskPriority, TaskStatus } from "../constants";
import type { DueState } from "../logic";

export interface BoardCard {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  dueState: DueState;
  assignees: string[];
  labels: string[];
  checklist: string | null;
}

/**
 * The board's columns. Dragging a card (mouse) or choosing "Move to" (touch,
 * keyboard, screen readers) moves it at once on screen, then saves; if saving
 * fails the card goes back and the reason is shown.
 */
export function BoardColumns({
  columns,
  cards: initial,
  basePath,
  canEdit,
  hiddenDone,
}: {
  columns: { status: TaskStatus; label: string }[];
  cards: BoardCard[];
  basePath: string;
  canEdit: boolean;
  hiddenDone: number;
}) {
  const [cards, setCards] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ status: TaskStatus; before: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function move(id: string, status: TaskStatus, before: string | null) {
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    const rest = cards.filter((c) => c.id !== id);
    const column = rest.filter((c) => c.status === status);
    const index = before ? Math.max(0, column.findIndex((c) => c.id === before)) : column.length;
    if (card.status === status && cards.filter((c) => c.status === status).findIndex((c) => c.id === id) === index) return;
    const moved = { ...card, status };
    // Insert into the flat list just before the target card (or after the column's last card).
    const anchor = before ?? column[column.length - 1]?.id ?? null;
    const at = anchor ? rest.findIndex((c) => c.id === anchor) + (before ? 0 : 1) : rest.length;
    const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
    const previous = cards;
    setCards(next);
    setError(null);
    startTransition(async () => {
      const result = await moveTaskAction(id, status, index);
      if (result.error) {
        setCards(previous);
        setError(result.error);
      }
    });
  }

  function onDrop(e: DragEvent, status: TaskStatus, before: string | null) {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/plain") || dragging;
    setDragging(null);
    setOver(null);
    if (id && id !== before) move(id, status, before);
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div role="alert" className="notice notice-error">
          <p>{error}</p>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {pending ? "Saving the move…" : ""}
      </p>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0" data-testid="board">
        {columns.map((col) => {
          const list = cards.filter((c) => c.status === col.status);
          const isOver = over?.status === col.status;
          return (
            <section
              key={col.status}
              aria-label={col.label}
              data-testid={`column-${col.status}`}
              className={`flex w-72 shrink-0 snap-start flex-col gap-2 rounded-lg border p-2 md:w-auto ${isOver ? "border-accent bg-accent-soft" : "border-line bg-surface-2"}`}
              onDragOver={(e) => {
                if (!canEdit) return;
                e.preventDefault();
                if (!isOver || over?.before !== null) setOver({ status: col.status, before: null });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => onDrop(e, col.status, null)}
            >
              <h2 className="flex items-center justify-between px-1 text-sm font-semibold">
                {col.label}
                <span className="text-xs font-normal text-subtle">{list.length}</span>
              </h2>
              {list.map((card) => (
                <article
                  key={card.id}
                  draggable={canEdit}
                  data-testid="board-card"
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", card.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(card.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (!canEdit) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (over?.before !== card.id) setOver({ status: col.status, before: card.id });
                  }}
                  onDrop={(e) => onDrop(e, col.status, card.id)}
                  className={`space-y-1.5 rounded-md border bg-surface p-2.5 shadow-sm ${canEdit ? "cursor-grab active:cursor-grabbing" : ""} ${dragging === card.id ? "opacity-50" : ""} ${over?.before === card.id ? "border-t-4 border-t-accent" : "border-line"}`}
                >
                  <Link href={`${basePath}/t/${card.id}`} className={`block text-sm font-medium hover:underline ${card.status === "done" ? "text-muted line-through" : ""}`}>
                    {card.title}
                  </Link>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                    {card.priority === "urgent" || card.priority === "high" ? (
                      <span className={card.priority === "urgent" ? "badge badge-danger" : "badge badge-warn"}>{card.priority === "urgent" ? "Urgent" : "High"}</span>
                    ) : null}
                    {card.due ? (
                      <span className={card.dueState === "overdue" ? "font-medium text-danger" : card.dueState === "today" ? "font-medium text-warn" : ""}>{card.due}</span>
                    ) : null}
                    {card.assignees.length ? <span>{card.assignees.join(", ")}</span> : null}
                    {card.checklist ? <span>☑ {card.checklist}</span> : null}
                  </div>
                  {card.labels.length ? (
                    <div className="flex flex-wrap gap-1">
                      {card.labels.map((l) => (
                        <span key={l} className="rounded-full border border-line px-1.5 text-[11px] text-muted">
                          {l}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {canEdit ? (
                    <label className="flex items-center gap-1 text-xs text-subtle">
                      <span>Move to</span>
                      <select
                        className="rounded border border-line bg-surface px-1 py-0.5 text-xs"
                        value={card.status}
                        aria-label={`Move “${card.title}” to`}
                        onChange={(e) => move(card.id, e.target.value as TaskStatus, null)}
                      >
                        {columns.map((c) => (
                          <option key={c.status} value={c.status}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </article>
              ))}
              {list.length === 0 ? <p className="px-1 py-4 text-center text-xs text-subtle">{canEdit ? "Drop a card here" : "Nothing here"}</p> : null}
              {col.status === "done" && hiddenDone > 0 ? <p className="px-1 text-xs text-subtle">and {hiddenDone} older done tasks (see the list view)</p> : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
