// React Native auth app (iOS + Android). Drives form-filling: focus field ->
// keyboard -> submit -> verify navigation to the authenticated home screen.

import type { AppArchetype } from "../types.ts";
import { makeFormScreen, makeScreen } from "./helpers.ts";

const archetype: AppArchetype = {
  id: "auth-login",
  name: "Habitly",
  platforms: ["ios", "android"],
  bundleId: "com.habitly.app",
  isReactNative: true,
  metroPort: 8081,
  entryScreen: "login",
  urls: { "habitly://login": "login" },
  screens: {
    login: makeFormScreen({
      key: "login",
      title: "Sign In",
      heading: "Welcome back",
      fields: [
        { key: "email", label: "Email", field: "email", identifier: "login-email" },
        { key: "password", label: "Password", field: "password", identifier: "login-password" },
      ],
      submit: {
        key: "signin",
        label: "Sign In",
        navigatesTo: "dashboard",
        identifier: "login-submit",
      },
    }),
    dashboard: makeScreen({
      key: "dashboard",
      title: "Today",
      heading: "Today",
      rows: [
        {
          key: "streak",
          label: "12 day streak",
          role: "text",
          component: "StreakLabel",
          identifier: "streak",
        },
        {
          key: "habit-water",
          label: "Drink water",
          role: "switch",
          component: "HabitRow",
          identifier: "habit-water",
          togglesState: "water",
        },
        {
          key: "habit-read",
          label: "Read 20 min",
          role: "switch",
          component: "HabitRow",
          identifier: "habit-read",
          togglesState: "read",
        },
        {
          key: "add-habit",
          label: "Add habit",
          component: "AddButton",
          identifier: "add-habit",
          navigatesTo: "newHabit",
        },
      ],
    }),
    newHabit: makeFormScreen({
      key: "newHabit",
      title: "New Habit",
      heading: "New Habit",
      fields: [
        {
          key: "habit-name",
          label: "Habit name",
          field: "habitName",
          identifier: "habit-name-input",
        },
      ],
      submit: {
        key: "save-habit",
        label: "Save",
        navigatesTo: "dashboard",
        identifier: "save-habit",
      },
    }),
  },
};

export default archetype;
