import { useCallback, useEffect, useState } from "react";
import { Button, Input, Menu, Pill, StateDot, Tooltip, writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import { mergeRows, mountSnippet } from "./rows.js";

/** Base class prefix; styles are injected once by `index.jsx`. */
export const C = "bwps";

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Inline password input + Save / Remove bound to one credential ref. */
function KeyEditor({ keyEnv, configured, api, t, onDone }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(/** @type {"save"|"remove"|null} */ (null));
	const [failure, setFailure] = useState(/** @type {string|undefined} */ (undefined));

	const save = async () => {
		if (value.trim().length === 0) return;
		setBusy("save");
		setFailure(undefined);
		try {
			await api.setKey(keyEnv, value.trim());
			setValue("");
			onDone(t("keySaved", { ref: keyEnv }), "saved");
		} catch (error) {
			setFailure(errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const remove = async () => {
		setBusy("remove");
		setFailure(undefined);
		try {
			await api.unsetKey(keyEnv);
			onDone(t("keyRemoved", { ref: keyEnv }), "removed");
		} catch (error) {
			setFailure(errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className={`${C}-keyEditor`}>
			<code className={`${C}-mono`}>{keyEnv}</code>
			<Input
				type="password"
				autoComplete="off"
				spellCheck={false}
				placeholder={t("keyPlaceholder")}
				value={value}
				disabled={busy !== null}
				onChange={(event) => setValue(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") void save();
				}}
			/>
			<Button variant="primary" size="sm" disabled={busy !== null || value.trim().length === 0} onClick={() => void save()}>
				{busy === "save" ? t("saving") : t("save")}
			</Button>
			{configured ? (
				<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void remove()}>
					{busy === "remove" ? t("removing") : t("remove")}
				</Button>
			) : null}
			{failure !== undefined ? <p role="alert" className={`${C}-error`}>{failure}</p> : null}
		</div>
	);
}

/** "Not mounted" hint with the composition snippet + copy button. */
function MountHint({ row, t }) {
	const [copied, setCopied] = useState(false);
	const snippet = mountSnippet(row);
	return (
		<div className={`${C}-mountHint`} data-mount-hint={row.id}>
			<p className={`${C}-muted`}>{t("mountHint")} <code className={`${C}-mono`}>~/.dsh/profiles/web/cordis.patch.yml</code>:</p>
			<div className={`${C}-snippet`}>
				<pre className={`${C}-mono`}>{snippet}</pre>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						void writeClipboard(snippet).then((ok) => {
							setCopied(ok);
							if (ok) setTimeout(() => setCopied(false), 1500);
						});
					}}
				>
					{copied ? t("copied") : t("copy")}
				</Button>
			</div>
		</div>
	);
}

/** Status text column, driven purely by `row.state`. */
function StatusText({ row, t }) {
	switch (row.state) {
		case "active": return <span className={`${C}-activeBadge`}>{t("active")}</span>;
		case "keyMissing": return <span className={`${C}-warn`}>{t("keyMissing")}</span>;
		case "unavailable": return <span className={`${C}-muted`}>{t("unavailable")}</span>;
		case "catalog": return <span className={`${C}-muted`}>{t("notMounted")}</span>;
		default: return null;
	}
}

/** Per-row "?" menu: docs, key link, free tier, key env, change/remove key. */
function RowMenu({ row, t, canEditKey, onEditKey, onRemoveKey }) {
	const [open, setOpen] = useState(false);
	const items = [];
	if (row.docsUrl) items.push({ id: "docs", label: t("docs") });
	if (row.keyUrl) items.push({ id: "keyUrl", label: t("getKey") });
	if (row.freeTier) items.push({ id: "freeTier", label: `${t("freeTier")}: ${row.freeTier}`, disabled: true });
	if (row.requiresKey === false) {
		items.push({ id: "noKey", label: t("noKeyNeeded"), disabled: true });
	} else if (row.keyEnv) {
		if (items.length > 0) items.push({ type: "separator", id: "sep1" });
		items.push({ id: "keyEnv", label: <>{t("keySource")}: <code className={`${C}-mono`}>{row.keyEnv}</code>{row.keySource ? ` (${row.keySource})` : ""}</>, disabled: true });
		if (canEditKey) {
			items.push({ id: "changeKey", label: row.keyConfigured === true ? t("changeKey") : t("addKey") });
			if (row.keyConfigured === true) items.push({ id: "removeKey", label: t("removeKey"), danger: true });
		}
	}
	if (items.length === 0) return null;

	const onSelect = (id) => {
		setOpen(false);
		if (id === "docs" && typeof window !== "undefined") window.open(row.docsUrl, "_blank", "noopener,noreferrer");
		else if (id === "keyUrl" && typeof window !== "undefined") window.open(row.keyUrl, "_blank", "noopener,noreferrer");
		else if (id === "changeKey") onEditKey();
		else if (id === "removeKey") onRemoveKey();
	};

	return (
		<Menu
			open={open}
			align="end"
			portal
			dense
			items={items}
			onSelect={onSelect}
			onClose={() => setOpen(false)}
			anchor={
				<Button variant="ghost" size="sm" aria-label={t("more")} aria-haspopup="menu" aria-expanded={open} data-row-menu={row.id} onClick={() => setOpen((v) => !v)}>
					?
				</Button>
			}
		/>
	);
}

function ProviderRow({ row, api, t, onNotice, busyId, setBusyId, credentialsWritable, expanded, setExpanded }) {
	const [justSaved, setJustSaved] = useState(false);
	const busy = busyId !== null;
	const canEditKey = row.keyEnv !== undefined && credentialsWritable;
	const editing = expanded === row.id;
	const kindLabel = t(`kind_${row.providerKind}`) === `kind_${row.providerKind}` ? row.providerKind : t(`kind_${row.providerKind}`);

	const use = async () => {
		setBusyId(row.id);
		try {
			await api.select(row.kind, row.id);
			onNotice(t("selected", { id: row.id }));
		} catch (error) {
			onNotice(errorMessage(error), true);
		} finally {
			setBusyId(null);
		}
	};
	const removeKey = async () => {
		try {
			await api.unsetKey(row.keyEnv);
			onNotice(t("keyRemoved", { ref: row.keyEnv }));
		} catch (error) {
			onNotice(errorMessage(error), true);
		}
	};

	let action = null;
	if (row.action === "use") {
		action = <Button variant="primary" size="sm" disabled={busy} onClick={() => void use()}>{t("use")}</Button>;
	} else if (row.action === "addKey") {
		const button = (
			<Button variant="outline" size="sm" disabled={!credentialsWritable} onClick={() => setExpanded(editing ? null : row.id)}>
				{editing ? t("hideKey") : t("addKey")}
			</Button>
		);
		action = credentialsWritable ? button : <Tooltip label={t("noCredentials")} side="top">{button}</Tooltip>;
	}

	const showMountHint = row.state === "catalog" && (justSaved || row.keyConfigured === true);

	return (
		<li
			className={`${C}-row`}
			data-provider={row.id}
			data-row-state={row.state}
			data-active={row.active ? "true" : undefined}
			data-usable={row.state === "active" || row.state === "usable" ? "true" : "false"}
			data-registered={row.registered ? "true" : "false"}
		>
			<div className={`${C}-rowMain`}>
				{row.dot === "on" ? <StateDot state="done" size={10} className={`${C}-dot`} /> : <i aria-hidden="true" className={`${C}-dot ${C}-dotOff`} />}
				<div className={`${C}-rowTitle`}>
					<strong className={`${C}-label`}>{row.label}</strong>
					<Pill className={`${C}-mono`}>{row.id}</Pill>
					<Pill>{kindLabel}</Pill>
				</div>
				<div className={`${C}-rowStatus`}><StatusText row={row} t={t} /></div>
				<div className={`${C}-rowActions`}>
					{action}
					<RowMenu row={row} t={t} canEditKey={canEditKey} onEditKey={() => setExpanded(row.id)} onRemoveKey={() => void removeKey()} />
				</div>
			</div>
			{editing && row.keyEnv !== undefined ? (
				<KeyEditor
					keyEnv={row.keyEnv}
					configured={row.keyConfigured === true}
					api={api}
					t={t}
					onDone={(message, outcome) => {
						setExpanded(null);
						if (row.state === "catalog" && outcome === "saved") setJustSaved(true);
						onNotice(message);
					}}
				/>
			) : null}
			{showMountHint ? <MountHint row={row} t={t} /> : null}
		</li>
	);
}

function Table({ title, rows, ...rest }) {
	return (
		<section className={`${C}-group`}>
			<h3>{title}</h3>
			{rows.length === 0 ? <p className={`${C}-muted`}>{rest.t("emptyGroup")}</p> : (
				<ul className={`${C}-list`}>
					{rows.map((row) => <ProviderRow key={row.id} row={row} {...rest} />)}
				</ul>
			)}
		</section>
	);
}

/**
 * Settings section body.
 * @param {{ api: { list(): Promise<any>, select(kind: string, id: string): Promise<any>, setKey(ref: string, value: string): Promise<any>, unsetKey(ref: string): Promise<any> }, t: (key: string, params?: Record<string, unknown>) => string }} props
 */
export function WebProvidersSection({ api, t }) {
	const [state, setState] = useState(/** @type {{ status: "loading" } | { status: "error", message: string } | { status: "ready", data: any }} */ ({ status: "loading" }));
	const [notice, setNotice] = useState(/** @type {{ text: string, error: boolean } | null} */ (null));
	const [busyId, setBusyId] = useState(/** @type {string|null} */ (null));
	const [expanded, setExpanded] = useState(/** @type {string|null} */ (null));

	const refresh = useCallback(async () => {
		try {
			const data = await api.list();
			setState({ status: "ready", data });
		} catch (error) {
			setState({ status: "error", message: errorMessage(error) });
		}
	}, [api]);

	useEffect(() => {
		let current = true;
		void api.list().then(
			(data) => { if (current) setState({ status: "ready", data }); },
			(error) => { if (current) setState({ status: "error", message: errorMessage(error) }); },
		);
		return () => { current = false; };
	}, [api]);

	const onNotice = (text, error = false) => {
		setNotice({ text, error });
		void refresh();
	};

	const data = state.status === "ready" ? state.data : undefined;
	const rows = data !== undefined ? mergeRows(data) : undefined;
	const shared = { api, t, onNotice, busyId, setBusyId, expanded, setExpanded, credentialsWritable: data?.credentialsWritable !== false };

	return (
		<div className={`${C}-section`} aria-busy={state.status === "loading"}>
			<header className={`${C}-header`}>
				<div>
					<h2>{t("title")}</h2>
					<p className={`${C}-muted`}>{t("intro")}</p>
				</div>
				<Button variant="ghost" size="sm" onClick={() => void refresh()}>{t("refresh")}</Button>
			</header>
			{state.status === "loading" ? <p className={`${C}-muted`}>{t("loading")}</p> : null}
			{state.status === "error" ? (
				<div className={`${C}-failure`} role="alert">
					<p>{t("error")}: {state.message}</p>
					<Button variant="outline" size="sm" onClick={() => { setState({ status: "loading" }); void refresh(); }}>{t("retry")}</Button>
				</div>
			) : null}
			{notice !== null ? (
				<p className={notice.error ? `${C}-error` : `${C}-notice`} role={notice.error ? "alert" : "status"}>{notice.text}</p>
			) : null}
			{data !== undefined && rows !== undefined ? (
				<>
					{data.persisted === false ? <p className={`${C}-warn`}>{t("notPersisted")}</p> : null}
					{data.credentialsWritable === false ? <p className={`${C}-warn`}>{t("noCredentials")}</p> : null}
					<Table title={t("searchGroup")} rows={rows.search} {...shared} />
					<Table title={t("fetchGroup")} rows={rows.fetch} {...shared} />
				</>
			) : null}
		</div>
	);
}
