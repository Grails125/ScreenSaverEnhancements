import { CSSProperties } from "react";

export const QUICK_ACCESS_MENU = ({ style }: { style?: CSSProperties }) => {
  return (
    <svg style={style} width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" fill="none" />
      <path
        d="m7.31,8.66C3.28,8.66.02,11.95.02,16s3.26,7.34,7.29,7.34h17.42c4.03,0,7.29-3.28,7.29-7.34s-3.26-7.33-7.29-7.33H7.31Zm3.24,7.33c0,1.01-.82,1.83-1.82,1.83s-1.82-.82-1.82-1.83.82-1.83,1.82-1.83,1.82.82,1.82,1.83Zm5.47,1.83c1.01,0,1.82-.82,1.82-1.83s-.82-1.83-1.82-1.83-1.82.82-1.82,1.83.82,1.83,1.82,1.83Zm9.11-1.83c0,1.01-.82,1.83-1.82,1.83s-1.82-.82-1.82-1.83.82-1.83,1.82-1.83,1.82.82,1.82,1.83Z"
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
};
