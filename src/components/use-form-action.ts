import { startTransition, useActionState, type FormEvent } from "react";

/**
 * useActionState for forms that must keep their input when the action fails.
 * React 19 resets a <form action> after every submission, including ones that
 * return an error, which wipes what the user typed. Submitting through
 * onSubmit skips that reset; callers reset explicitly on success if they want.
 */
export function useFormAction<S>(fn: (state: Awaited<S>, formData: FormData) => S | Promise<S>, initial: Awaited<S>) {
  const [state, action, pending] = useActionState(fn, initial);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  }

  return { state, pending, formProps: { action, onSubmit } };
}
