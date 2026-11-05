import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, LoaderCircle, Plus, RefreshCw, Sparkles, Square } from "lucide-react";
import Markdown from "react-markdown";
import type { AgentChat } from "../../agent-chat";
import type { AgentLabProvider } from "../../agent-lab-api";
import { Button, buttonClasses } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { IconButton } from "../../ui/IconButton";
import { Select } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";
import { documentSupportClasses, documentTitleClasses } from "../DocumentUI";

const starters = [
  { label: "Understand this project", question: "How is an AWS Studio project organized, and where should I start?" },
  { label: "Local vs. production", question: "How do local development and production differ in this framework?" },
  { label: "Talk through an idea", question: "Help me think through adding a new API endpoint. What should I consider?" },
];

/** One column for reading and asking: wide enough for a code example, near 100 characters of prose. */
const columnClasses = "mx-auto w-full max-w-[752px] px-4";

function Answer({ text }: { text: string }) {
  return <Markdown skipHtml disallowedElements={["img"]} components={{
    p: ({ children }) => <p className="mt-0 mb-3 last:mb-0">{children}</p>,
    h1: ({ children }) => <h3 className="mt-4 mb-2 text-body font-semibold first:mt-0">{children}</h3>,
    h2: ({ children }) => <h3 className="mt-4 mb-2 text-body font-semibold first:mt-0">{children}</h3>,
    h3: ({ children }) => <h3 className="mt-4 mb-2 text-body font-semibold first:mt-0">{children}</h3>,
    ul: ({ children }) => <ul className="mt-0 mb-3 grid gap-1 pl-5 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mt-0 mb-3 grid gap-1 pl-5 last:mb-0">{children}</ol>,
    pre: ({ children }) => <pre tabIndex={0} aria-label="Code example" className="my-3 max-w-full overflow-auto rounded-md border border-rule bg-paper p-3 font-mono text-caption [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
    code: ({ children }) => <code className="rounded-sm bg-wash px-1 py-0.5 font-mono text-caption">{children}</code>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="underline decoration-rule-strong underline-offset-3 hover:decoration-ink">{children}</a>,
    blockquote: ({ children }) => <blockquote className="mx-0 my-3 border-l-2 border-rule-strong pl-3 text-graphite">{children}</blockquote>,
  }}>{text}</Markdown>;
}

export function AgentPanel({ chat, visible }: { chat: AgentChat; visible: boolean }) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [below, setBelow] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [copyError, setCopyError] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const previousPending = useRef(false);
  const name = chat.provider === "codex" ? "Codex" : "Claude";
  const available = chat.selected?.available === true;
  const otherBusy = chat.status.data?.busy && !chat.pending;
  const canSend = available && !!chat.draft.trim() && chat.draft.length <= 4000 && !otherBusy && !chat.modelUnavailable;
  const modelProblem = chat.catalog.error?.message ?? chat.catalog.data?.problem;
  const blocked = chat.status.isPending || !available || !!otherBusy || !!chat.status.error;
  const modelNotice = available && (!!modelProblem || chat.modelUnavailable);
  const last = chat.messages.at(-1);

  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  }, [chat.draft, visible]);
  useEffect(() => {
    if (!visible) return;
    if (document.activeElement?.getAttribute("role") !== "tab") composer.current?.focus({ preventScroll: true });
  }, [visible]);
  useEffect(() => {
    if (!chat.messages.length) { pinned.current = true; setBelow(false); }
    if (!visible) return;
    const element = transcript.current;
    if (element && pinned.current) {
      const answer = last?.role === "assistant" ? element.querySelector("article:last-of-type") : null;
      // A complete answer arrives at once: put its beginning in view so reading starts there.
      element.scrollTop = answer ? element.scrollTop + answer.getBoundingClientRect().top - element.getBoundingClientRect().top - 16 : chat.messages.length ? element.scrollHeight : 0;
      setBelow(false);
    } else if (last?.role === "assistant") setBelow(true);
  }, [chat.messages, chat.pending, chat.problem, chat.stopped, visible]);
  useEffect(() => {
    if (chat.pending && !previousPending.current) pinned.current = true;
    previousPending.current = chat.pending;
  }, [chat.pending]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setCopyError(false); }
    catch { setCopyError(true); }
  };
  const useStarter = (question: string) => { chat.setDraft(question); composer.current?.focus(); };
  const send = () => { pinned.current = true; setConfirmClear(false); chat.send(); composer.current?.focus(); };

  return <div className="flex min-h-0 flex-1 flex-col bg-sheet" data-ui="agent-panel">
    <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-offset-[-2px]" aria-label="Conversation" tabIndex={0}
      onScroll={event => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        if (pinned.current) setBelow(false);
      }}>
      <div className={cx(columnClasses, "flex min-h-full flex-col py-3", !chat.messages.length && "justify-center")}>
        {!chat.messages.length ? <div className="grid gap-3">
          <div className="grid gap-1">
            <h2 className={documentTitleClasses}>A little help, right where you work.</h2>
            <p className={documentSupportClasses}>Ask a question, untangle a concept, or think through your next step.</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
            {starters.map(starter => <Button key={starter.label} type="button" size="compact" variant="quiet" onClick={() => useStarter(starter.question)}>{starter.label}</Button>)}
          </div>
        </div> : <div className="grid gap-4">
          {chat.messages.map(message => <article key={message.id} className="min-w-0" aria-label={message.role === "user" ? "Your question" : `${message.provider === "codex" ? "Codex" : "Claude"} answer`}>
            <div className="mb-1 flex min-h-7 items-center gap-2 text-caption">
              {message.role === "assistant" ? <Sparkles size={13} aria-hidden /> : null}
              <span className="font-semibold">{message.role === "user" ? "You" : message.provider === "codex" ? "Codex" : "Claude"}</span>
              {message.role === "assistant" && message.modelLabel ? <span className="text-graphite">{message.modelLabel}</span> : null}
              {message.replyState ? <span className="text-graphite">{message.replyState === "stopped" ? "Reply stopped" : "Reply failed"}</span> : null}
              {message.role === "assistant" ? <IconButton type="button" variant="quiet" size="compact" className="ml-auto" aria-label={copied === message.id ? "Answer copied" : "Copy answer"} title="Copy answer" onClick={() => void copy(message.id, message.content)}>
                {copied === message.id ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
              </IconButton> : null}
            </div>
            <div className="text-body leading-relaxed wrap-anywhere">
              {message.role === "user" ? <p className="m-0 w-fit max-w-full rounded-md bg-wash px-3 py-2 whitespace-pre-wrap">{message.content}</p> : <Answer text={message.content} />}
            </div>
          </article>)}
          {chat.pending ? <div role="status" className="flex items-center gap-2 text-caption text-graphite"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />{name} is thinking…</div> : null}
          {chat.problem || chat.stopped ? <Notice tone={chat.problem ? "error" : "neutral"} className="flex flex-wrap items-center gap-3" role={chat.problem ? "alert" : "status"}>
            <span className="min-w-0 flex-1">{chat.problem ?? "Response stopped."}</span>
            <Button type="button" size="compact" variant="quiet" disabled={!available || !!otherBusy || chat.modelUnavailable} onClick={chat.retry}><RefreshCw size={12} aria-hidden />Try again</Button>
          </Notice> : null}
        </div>}
      </div>
    </div>
    <div className={cx("flex-none bg-sheet", !!chat.messages.length && "border-t border-rule")} onKeyDown={event => {
      if (event.key === "Escape" && confirmClear) { event.stopPropagation(); setConfirmClear(false); }
    }}>
      <form className={cx(columnClasses, "relative grid gap-1 pt-2 pb-3")} onSubmit={event => { event.preventDefault(); send(); }}>
        {below ? <Button type="button" size="compact" variant="neutral" className="absolute right-4 -top-7 shadow-sm" onClick={() => {
          if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
          pinned.current = true; setBelow(false);
        }}><ArrowDown size={12} aria-hidden />Latest reply</Button> : null}
        <div className="flex items-end rounded-lg border border-rule-strong bg-paper focus-within:border-faint vp-650:flex-wrap">
          <label htmlFor="studio-agent-question" className="sr-only">Ask the agent</label>
          <textarea ref={composer} id="studio-agent-question" value={chat.draft} maxLength={4000} rows={1}
            className="block min-h-11 min-w-0 flex-1 resize-none rounded-lg border-0 bg-transparent px-3 py-3 text-body leading-5 outline-none placeholder:text-faint focus-visible:outline-none vp-650:basis-full vp-650:pb-1"
            placeholder={chat.messages.length ? "Ask a follow-up…" : "Ask a question…"}
            aria-describedby="agent-composer-help"
            onChange={event => chat.setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault(); if (!chat.pending && canSend) send();
              }
            }} />
          <div className="flex min-w-0 flex-none items-center gap-1 p-2 vp-650:w-full vp-650:flex-1 vp-650:pt-0">
            <label className="sr-only" htmlFor="studio-agent-provider">Agent provider</label>
            <Select id="studio-agent-provider" appearance="quiet" controlSize="compact" className="max-w-full text-caption" value={chat.provider} disabled={chat.pending}
              onChange={event => chat.setProvider(event.target.value as AgentLabProvider)}><option value="codex">Codex</option><option value="claude">Claude</option></Select>
            <label className="sr-only" htmlFor="studio-agent-model">Agent model</label>
            <Select id="studio-agent-model" appearance="quiet" controlSize="compact" className="max-w-45 text-caption" value={chat.model}
              disabled={chat.pending || !available} title={chat.selectedModel?.description ?? "Choose a model"}
              onChange={event => chat.setModel(event.target.value)}>
              <option value="">CLI default</option>
              {chat.model && !chat.selectedModel ? <option value={chat.model}>{chat.model}{chat.modelUnavailable ? " (unavailable)" : ""}</option> : null}
              {chat.catalog.data?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
              {chat.catalog.isFetching && !chat.catalog.data ? <option disabled>Loading models…</option> : null}
            </Select>
            {chat.pending ? <IconButton type="button" size="compact" className="ml-1 vp-650:ml-auto" aria-label="Stop" title="Stop" onClick={chat.stop}><Square size={12} aria-hidden /></IconButton>
              : <IconButton type="submit" variant={canSend ? "primary" : "quiet"} size="compact" className="ml-1 vp-650:ml-auto" aria-label="Send" title="Send" disabled={!canSend}><ArrowUp size={14} aria-hidden /></IconButton>}
          </div>
        </div>
        <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-graphite">
          <div className="grid min-w-0 flex-1 gap-1">
            {blocked ? <div role={chat.status.error ? "alert" : "status"} className={cx("flex flex-wrap items-center gap-x-3", chat.status.error ? "text-refuse" : !chat.status.isPending && !otherBusy && "text-local")}>
              <span className="min-w-0 wrap-anywhere">{chat.status.isPending ? "Checking your local agents…" : chat.status.error?.message ?? (otherBusy ? "Another agent request is running. Check again when it finishes." : chat.selected?.detail ?? "Check your local CLI installation to get started.")}</span>
              {!chat.status.isPending ? <button type="button" className={buttonClasses({ variant: "link", className: "shrink-0" })} disabled={chat.status.isFetching} onClick={() => void chat.status.refetch()}>{chat.status.isFetching ? "Checking…" : "Check again"}</button> : null}
            </div> : null}
            {modelNotice ? <div role="status" className="flex flex-wrap items-center gap-x-3">
              <span className="min-w-0 wrap-anywhere">{chat.modelUnavailable ? "This model is no longer listed. Choose another model or CLI default." : `${modelProblem} You can still use CLI default.`}</span>
              <button type="button" className={buttonClasses({ variant: "link", className: "shrink-0" })} disabled={chat.catalog.isFetching} onClick={chat.refreshModels}>{chat.catalog.isFetching ? "Refreshing…" : "Refresh models"}</button>
            </div> : null}
            {copyError ? <span role="status">Couldn’t copy. You can select the answer text to copy it.</span> : null}
            {/* A reason the composer can't be used takes this line's place; the description stays for the field. */}
            <span id="agent-composer-help" className={blocked || modelNotice || copyError ? "sr-only" : undefined}>{chat.messages.length ? "Enter to send · Shift+Enter for a new line" : "Questions and answers · No changes to your project"}</span>
          </div>
          {chat.messages.length ? <div className="flex items-center gap-2">
            {confirmClear ? <><span>Clear this chat?</span><button type="button" className={buttonClasses({ variant: "link" })} onClick={() => { chat.clear(); setConfirmClear(false); composer.current?.focus(); }}>Clear</button><button type="button" className={buttonClasses({ variant: "link" })} onClick={() => setConfirmClear(false)}>Keep</button></>
              : <button type="button" className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-inherit hover:text-ink disabled:opacity-45" disabled={chat.pending} onClick={() => setConfirmClear(true)}><Plus size={12} aria-hidden />New chat</button>}
          </div> : null}
        </div>
      </form>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{last?.role === "assistant" ? "Answer ready." : ""}{copied ? " Answer copied." : ""}</span>
  </div>;
}
