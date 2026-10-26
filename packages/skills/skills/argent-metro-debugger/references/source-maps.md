# Missing source locations in `debugger-inspect-element`

`debugger-inspect-element` resolves each component to its source from the fiber's `_debugStack` (symbolicated through Metro) or, failing that, its `_debugSource`. With neither, every item comes back with `source: null` and `code: null`; the component names are still useful.

All items `source: null` means the project's Babel configuration does not inject source information into JSX elements. This is common with the **automatic JSX transform** (Expo SDK 50+ and React Native 0.73+).

**To enable source resolution**, tell the user they can add `@babel/plugin-transform-react-jsx-source` to the project's Babel config. For example, in `babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"], // or 'module:@react-native/babel-preset'
    plugins: [
      "@babel/plugin-transform-react-jsx-source", // enables _debugSource on fibers
    ],
  };
};
```

After adding the plugin, restart Metro with a cache reset (`npx react-native start --reset-cache` or `npx expo start --clear`) and reload the app. No extra `npm install` is needed; the plugin ships with `babel-preset-expo` and `@babel/preset-env`.
