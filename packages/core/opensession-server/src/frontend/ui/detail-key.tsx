/** Left column of a detail drawer's key/value grid ("Trigger", "Schedule"). */
export function DetailKey({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-faint text-label leading-[1.7] whitespace-nowrap">
      {children}
    </span>
  );
}
