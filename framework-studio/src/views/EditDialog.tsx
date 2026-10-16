import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlanResponse, PreflightResult } from "../../shared/api";
import { api, ApiError } from "../api";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";

function Verdict(props: { readonly label: string; readonly result: PreflightResult }) {
  const { result } = props;
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  return (
    <div className={`check ${result.ok ? "ok" : "refused"}`}>
      <strong>
        {result.ok ? <Check size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}
        {props.label}: {result.ok ? "accepted" : "refused"}
      </strong>
      {errors.map((diagnostic, position) => (
        <p key={position} className="message">
          {diagnostic.message}
        </p>
      ))}
      {warnings.map((diagnostic, position) => (
        <p key={`w${position}`} className="message muted">
          {diagnostic.message}
        </p>
      ))}
      {result.ok && result.predicted ? (
        <p className="message muted">
          Resolves to {String(result.predicted.effective)}, {result.predicted.provenance}.
        </p>
      ) : null}
    </div>
  );
}

export function EditDialog(props: { readonly plan: PlanResponse }) {
  const { closePreview, toast, index } = useStudio();
  const { plan } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const write = async () => {
    setWriting(true);
    try {
      const outcome = await api.apply(plan.planId);
      toast(outcome.message, outcome.status === "applied" ? "plain" : "refuse");
      closePreview();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : String(error), "refuse");
      closePreview();
    } finally {
      setWriting(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="preview"
      aria-labelledby="preview-title"
      onClose={closePreview}
      onCancel={(event) => {
        event.preventDefault();
        closePreview();
      }}
    >
      <header>
        <p className="muted small">{titleOf(index, plan.target)}</p>
        <h2 id="preview-title">{plan.summary}</h2>
      </header>
      <div className="body">
        <div className="checks">
          <Verdict label="Development graph" result={plan.preflight.dev} />
          <Verdict label="Production graph" result={plan.preflight.prod} />
        </div>
        {plan.impact.length > 0 ? (
          <div>
            <h3 style={{ margin: "0 0 6px", fontSize: "var(--step-0)" }}>What else changes</h3>
            <ul className="impact">
              {plan.impact.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="diff" aria-label={`Change to ${plan.file}`}>
          <div className="file">{plan.file}</div>
          <table>
            <tbody>
              {plan.diff.lines.map((line, position) => (
                <tr key={position} className={line.kind}>
                  <td className="number">{line.oldLine ?? ""}</td>
                  <td className="number">{line.newLine ?? ""}</td>
                  <td>
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                    {line.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Only the lines shown change. Checked against the framework's own validation for both graphs, not against a CDK synth.
        </p>
      </div>
      <footer>
        {plan.ok ? null : <span className="reason">The framework refuses this change, so it cannot be written.</span>}
        <button className="quiet" onClick={closePreview}>
          Cancel
        </button>
        <button className="primary" onClick={() => void write()} disabled={!plan.ok || writing} autoFocus={plan.ok}>
          {writing ? "Writing…" : `Write to ${plan.file}`}
        </button>
      </footer>
    </dialog>
  );
}
