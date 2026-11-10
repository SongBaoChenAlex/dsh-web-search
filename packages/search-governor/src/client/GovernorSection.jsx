import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { FIELDS, GROUPS, fieldState, plan, shell, specOf, summary } from "./form.js";

/** Base class prefix; styles are injected once by `index.jsx`. */
export const C = "bwsg";

function useScope(scope) {
	return useSyncExternalStore(
		useCallback((listener) => scope.subscribe(listener), [scope]),
		() => scope.getSnapshot(),
		() => scope.getSnapshot(),
	);
}

function Badges({ state, spec, t, disabled, onReset }) {
	return (
		<span className={`${C}-badges`}>
			{spec.restart ? <span className={`${C}-badgeMuted`} title={t("restartHint")}>↻</span> : null}
			{state.overridden ? <span className={`${C}-badge`}>{t("overridden")}</span> : null}
			{state.overridden ? (
				<button type="button" className={`${C}-reset`} disabled={disabled} onClick={onReset}>{t("reset")}</button>
			) : null}
		</span>
	);
}

function Control({ spec, state, t, disabled, onEdit }) {
	const id = `governor-${spec.key}`;
	const cls = state.invalid ? `${C}-input ${C}-invalid` : `${C}-input`;
	switch (spec.kind) {
		case "bool":
			return (
				<select id={id} className={cls} disabled={disabled} value={state.text} onChange={(e) => onEdit(e.target.value)}>
					<option value="">{t("inherit")}{state.fallback !== undefined ? ` (${state.fallback ? t("yes") : t("no")})` : ""}</option>
					<option value="true">{t("yes")}</option>
					<option value="false">{t("no")}</option>
				</select>
			);
		case "enum":
			return (
				<select id={id} className={cls} disabled={disabled} value={state.text} onChange={(e) => onEdit(e.target.value)}>
					<option value="">{t("inherit")}{typeof state.fallback === "string" ? ` (${state.fallback})` : ""}</option>
					{(spec.options ?? []).map((o) => <option key={o} value={o}>{t(`mode_${o}`)}</option>)}
				</select>
			);
		case "textarea":
			return (
				<textarea id={id} className={cls} rows={3} disabled={disabled} value={state.text} spellCheck={false} onChange={(e) => onEdit(e.target.value)} />
			);
		default:
			return (
				<input
					id={id}
					className={cls}
					type="text"
					inputMode={spec.kind === "int" || spec.kind === "ratio" ? "decimal" : undefined}
					disabled={disabled}
					value={state.text}
					placeholder={state.fallback !== undefined && state.fallback !== "" ? String(state.fallback) : ""}
					spellCheck={false}
					onChange={(e) => onEdit(e.target.value)}
				/>
			);
	}
}

function Field({ spec, snapshot, drafts, t, disabled, onEdit, onReset }) {
	const state = fieldState(spec, snapshot, drafts);
	const effective = state.effective;
	const showEffective = state.dirty && effective !== undefined && String(effective) !== state.text;
	return (
		<div className={`${C}-field`} data-field={spec.key} data-invalid={state.invalid ? "true" : undefined}>
			<div className={`${C}-head`}>
				<label className={`${C}-label`} htmlFor={`governor-${spec.key}`}>{t(spec.key)}</label>
				<Badges state={state} spec={spec} t={t} disabled={disabled} onReset={onReset} />
			</div>
			<Control spec={spec} state={state} t={t} disabled={disabled} onEdit={onEdit} />
			<p className={state.invalid ? `${C}-hintInvalid` : `${C}-hint`}>
				{state.invalid ? t("invalid") : t(`${spec.key}_hint`)}
				{showEffective ? <span className={`${C}-muted`}> · {t("effective")}: <code className={`${C}-mono`}>{String(effective)}</code></span> : null}
			</p>
		</div>
	);
}

/**
 * Settings section body.
 * @param {{ scope: { getSnapshot(): any, subscribe(l: () => void): () => void, set(f: string, v: unknown): Promise<void>, unset(f: string): Promise<void>, load(): Promise<void> }, t: (key: string, params?: Record<string, unknown>) => string }} props
 */
export function GovernorSection({ scope, t }) {
	const snapshot = useScope(scope);
	const [drafts, setDrafts] = useState(/** @type {Record<string, { text: string, clear?: boolean }>} */ ({}));
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState(/** @type {{ text: string, error: boolean } | null} */ (null));

	const flags = useMemo(() => shell(snapshot, drafts), [snapshot, drafts]);
	const disabled = !flags.available || !flags.writable || saving;

	const edit = (key, text) => {
		setNotice(null);
		setDrafts((d) => ({ ...d, [key]: { text, clear: false } }));
	};
	const reset = (key) => {
		setNotice(null);
		setDrafts((d) => ({ ...d, [key]: { text: "", clear: true } }));
	};
	const discard = () => {
		setDrafts({});
		setNotice(null);
	};
	const save = async () => {
		const writes = plan(snapshot, drafts);
		if (writes.length === 0 || writes.some((w) => w.op === undefined)) return;
		setSaving(true);
		setNotice(null);
		try {
			for (const w of writes) {
				if (w.op === "set") await scope.set(w.field, w.value);
				else await scope.unset(w.field);
			}
			await scope.load();
			const after = scope.getSnapshot();
			const landed = writes.every((w) => (w.op === "set" ? after.user?.[w.field] === w.value : !(after.user && Object.hasOwn(after.user, w.field))));
			if (landed) {
				setDrafts({});
				setNotice({ text: t("saved"), error: false });
			} else {
				setNotice({ text: t("saveFailed"), error: true });
			}
		} catch {
			setNotice({ text: t("saveFailed"), error: true });
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className={`${C}-section`} aria-busy={snapshot.status === "loading"}>
			<header className={`${C}-header`}>
				<div>
					<h2>{t("title")}</h2>
					<p className={`${C}-muted`}>{t("intro")}</p>
					{snapshot.status === "ready" ? <p className={`${C}-mono ${C}-summary`}>{summary(snapshot.value)}</p> : null}
				</div>
				<Button variant="ghost" size="sm" onClick={() => void scope.load()}>{t("refresh")}</Button>
			</header>

			{snapshot.status === "loading" ? <p className={`${C}-muted`}>{t("loading")}</p> : null}
			{snapshot.status === "unavailable" ? <p className={`${C}-warn`} role="status">{t("unavailable")}</p> : null}
			{snapshot.status === "ready" && !flags.writable ? <p className={`${C}-warn`} role="status">{t("readOnly")}</p> : null}

			{snapshot.status === "ready" ? (
				<>
					{GROUPS.map((group) => (
						<section key={group} className={`${C}-group`}>
							<h3>{t(`group_${group}`)}</h3>
							<div className={`${C}-grid`}>
								{FIELDS.filter((f) => f.group === group).map((spec) => (
									<Field
										key={spec.key}
										spec={spec}
										snapshot={snapshot}
										drafts={drafts}
										t={t}
										disabled={disabled}
										onEdit={(text) => edit(spec.key, text)}
										onReset={() => reset(spec.key)}
									/>
								))}
							</div>
						</section>
					))}
					<footer className={`${C}-footer`}>
						{notice !== null ? <p className={notice.error ? `${C}-error` : `${C}-notice`} role={notice.error ? "alert" : "status"}>{notice.text}</p> : null}
						{flags.dirty && notice === null ? <p className={`${C}-muted`}>{flags.invalid ? t("invalid") : t("unsaved")}</p> : null}
						<span className={`${C}-spacer`} />
						<Button variant="outline" size="sm" disabled={!flags.dirty || saving} onClick={discard}>{t("discard")}</Button>
						<Button variant="primary" size="sm" disabled={!flags.dirty || flags.invalid || disabled} onClick={() => void save()}>{saving ? t("saving") : t("save")}</Button>
					</footer>
				</>
			) : null}
		</div>
	);
}

export { specOf };
