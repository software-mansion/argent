import React from "react";
import DocSidebar from "@theme-original/DocSidebar";
import type DocSidebarType from "@theme/DocSidebar";
import type { WrapperProps } from "@docusaurus/types";
import type { PropSidebarItem } from "@docusaurus/plugin-content-docs";

import SidebarIcon from "@site/src/theme/SidebarIcon";

type Props = WrapperProps<typeof DocSidebarType>;

/*
 * The shared theme (@swmansion/t-rex-ui) renders its sidebar items straight
 * from its own bundle, so swizzling DocSidebarItem has no effect. The items
 * prop is the last place the theme still reads from the site, and every item
 * renders its label as the link's children, so putting the icon in front of
 * the label is enough to get it into the menu.
 */
function withIcons(items: readonly PropSidebarItem[]): PropSidebarItem[] {
  return items.map((item) => {
    // Category headings stay plain; only the pages under them carry an icon.
    if (item.type === "category") {
      return { ...item, items: withIcons(item.items) };
    }

    const icon = item.type === "link" ? item.customProps?.icon : undefined;
    if (item.type !== "link" || !icon) {
      return item;
    }

    return {
      ...item,
      label: (
        <>
          <SidebarIcon name={icon} />
          {item.label}
        </>
      ) as unknown as string,
    };
  });
}

export default function DocSidebarWrapper(props: Props): React.ReactElement {
  return <DocSidebar {...props} sidebar={withIcons(props.sidebar)} />;
}
