import {
  PROJECT_URL,
  AUTHOR_URL,
  AUTHOR_NAME,
  PROJECT_NAME,
} from "../constants";

export default function Footer() {
  return (
    <footer className="text-muted-foreground/70 py-3 text-center text-xs">
      <span>
        {PROJECT_NAME} v{__APP_VERSION__}
      </span>
      <span className="mx-1.5">·</span>
      <a
        href={PROJECT_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="View project on GitLab"
        className="hover:text-foreground transition-colors"
      >
        Source Code
      </a>
      <span className="mx-1.5">·</span>
      <span>
        by{" "}
        <a
          href={AUTHOR_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          {AUTHOR_NAME}
        </a>
      </span>
    </footer>
  );
}
