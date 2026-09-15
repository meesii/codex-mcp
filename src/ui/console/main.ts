import { createApp } from "vue";
import "element-plus/theme-chalk/dark/css-vars.css";
import "./styles.css";
import App from "./App.vue";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", darkQuery.matches);
applyTheme();
darkQuery.addEventListener("change", applyTheme);

const root = document.getElementById("console-root");
if (!root) throw new Error("Console root is missing");

createApp(App).mount(root);
