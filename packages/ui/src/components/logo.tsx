import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 8V16H4V8H12Z" fill="var(--icon-weak-base)" />
      <path
        data-slot="logo-logo-mark-d"
        fill-rule="evenodd"
        d="M16 20H0V0H16V20ZM12 4H4V16H12V4ZM10 6H6V14H10V6Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Outer frame */}
      <path d="M80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
      {/* "D" lettermark: outer rect minus inner cutout, using evenodd */}
      <path
        fill-rule="evenodd"
        d="M20 20H60V80H20V20Z M30 30H50V70H30V30Z"
        fill="var(--icon-base)"
      />
      {/* left bar of D */}
      <path d="M20 20H30V80H20V20Z" fill="var(--icon-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 144 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* D */}
        <path d="M18 30H6V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--icon-base)" />
        {/* D */}
        <path d="M66 30H54V18H66V30Z" fill="var(--icon-weak-base)" />
        <path d="M66 12H54V30H66V12ZM72 36H48V6H72V36Z" fill="var(--icon-base)" />
        {/* M */}
        <path d="M96 18H84V30H96V18Z" fill="var(--icon-weak-base)" />
        <path d="M120 18H108V30H120V18Z" fill="var(--icon-weak-base)" />
        <path d="M84 6H78V36H84V6ZM96 6H84V18H96V6ZM108 6H96V18H108V6ZM120 6H108V18H120V6ZM126 6H120V36H126V6ZM132 36H78V6H132V36Z" fill="var(--icon-base)" />
      </g>
    </svg>
  )
}
