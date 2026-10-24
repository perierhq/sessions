import React from "react";
import { ANYONE, OUTSIDE_TEAM, authorFilterLabel } from "../lib/author-filter";
import type { Person } from "../lib/people";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { IconGlobe, IconPeople } from "./icons";
import { UserAvatar } from "./UserAvatar";

/**
 * Whose pull requests or issues a list shows. The two scopes that are not one
 * person sit together at the top: everyone, and everyone who is not on the
 * team (the public and bots). The roster follows, you first.
 */
export function AuthorFilterMenu({
  value,
  onChange,
  people,
  currentUser,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The roster, already in display order. */
  people: Person[];
  currentUser: string;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            className="min-w-0"
            icon={<IconPeople size={18} />}
            caret
          >
            <span className="max-w-[150px] truncate">
              {authorFilterLabel(value)}
            </span>
          </Button>
        }
      />
      <Menu.Popup align="end" className="min-w-[200px] max-w-[320px]">
        <Menu.RadioGroup
          value={value}
          onValueChange={(next) => onChange(String(next))}
        >
          <Menu.RadioItem value={ANYONE} closeOnClick>
            {/* Sized to the faces below so every label shares one edge. */}
            <span className="size-[18px] shrink-0" />
            <span className="min-w-0 flex-1 truncate">Anyone</span>
            <Menu.Check on={value === ANYONE} />
          </Menu.RadioItem>
          <Menu.RadioItem value={OUTSIDE_TEAM} closeOnClick>
            <IconGlobe size={18} className="shrink-0 text-dim" />
            <span className="min-w-0 flex-1 truncate">Outside the team</span>
            <Menu.Check on={value === OUTSIDE_TEAM} />
          </Menu.RadioItem>
          <Menu.Separator />
          {people.map((who) => {
            const key = who.name.toLowerCase();
            return (
              <Menu.RadioItem key={key} value={key} closeOnClick>
                <UserAvatar name={who.name} size={18} />
                <span className="min-w-0 flex-1 truncate">
                  {key === currentUser.toLowerCase()
                    ? `${who.fullName} (you)`
                    : who.fullName}
                </span>
                <Menu.Check on={value === key} />
              </Menu.RadioItem>
            );
          })}
        </Menu.RadioGroup>
      </Menu.Popup>
    </Menu.Root>
  );
}
