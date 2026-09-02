import React from "react";
import DocSidebar from "@theme-original/DocSidebar";
import type DocSidebarType from "@theme/DocSidebar";
import type { WrapperProps } from "@docusaurus/types";
import type { PropSidebarItem } from "@docusaurus/plugin-content-docs";

import SidebarIcon from "@site/src/theme/SidebarIcon";

type Props = WrapperProps<typeof DocSidebarType>;

/*
 * The shared theme (@swmansion/t-rex-ui) renders sidebar items from its own
 * bundle, so swizzling DocSidebarItem has no effect; an item's label is
 * rendered as the link's children, so the icon has to ride along in there.
 */
function withIcons(items: readonly PropSidebarItem[]): PropSidebarItem[] {
  return items.map((item) => {
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
