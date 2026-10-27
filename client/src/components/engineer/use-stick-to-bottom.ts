import { useCallback, useRef, useState } from "react";

/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_SLACK_PX = 24;

/**
 * Keeps a scrollable transcript pinned to its newest line while new lines,
 * streamed text or a re-shown container change its size. If the user scrolls
 * up to read, it stops following until they come back to the bottom.
 * Returns a callback ref so it re-attaches when the list remounts (drawer reopened).
 */
export function useStickToBottom<T extends HTMLElement>() {
  const element = useRef<T | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback(() => {
    if (!element.current) return;
    element.current.scrollTop = element.current.scrollHeight;
    pinned.current = true;
    setShowJump(false);
  }, []);

  const ref = useCallback((node: T | null) => {
    detach.current?.();
    detach.current = null;
    element.current = node;
    if (!node) return;
    // A freshly opened transcript starts at the newest line.
    pinned.current = true;
    setShowJump(false);
    const follow = () => { if (pinned.current) node.scrollTop = node.scrollHeight; };
    const onScroll = () => {
      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;
      pinned.current = atBottom;
      setShowJump(!atBottom);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    // New lines and streamed text change the content; resizing the window changes the box.
    const mutations = new MutationObserver(follow);
    mutations.observe(node, { childList: true, subtree: true, characterData: true });
    const resizes = new ResizeObserver(follow);
    resizes.observe(node);
    follow();
    detach.current = () => { node.removeEventListener("scroll", onScroll); mutations.disconnect(); resizes.disconnect(); };
  }, []);

  return { ref, showJump, scrollToBottom };
}
