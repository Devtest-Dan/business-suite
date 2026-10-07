"use client";

import { useEffect } from "react";
import { markAnnouncementRead } from "../actions";

/** Records the read receipt once the post is actually on screen (not on a link prefetch). */
export function MarkRead({ postId }: { postId: string }) {
  useEffect(() => {
    void markAnnouncementRead(postId);
  }, [postId]);
  return null;
}
