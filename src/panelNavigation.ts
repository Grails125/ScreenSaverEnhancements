type ScrollAncestor = {
  parentElement: ScrollAncestor | null;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

export const resetSecondaryPageScroll = (trigger: ScrollAncestor | null) => {
  let current = trigger;
  while (current) {
    if (current.scrollHeight > current.clientHeight) {
      current.scrollTop = 0;
    }
    current = current.parentElement;
  }
};
