import { Notice, Plugin, TFile, request } from "obsidian";
import { extractFromXml } from "@extractus/feed-extractor";

export default class ReadLaterPlugin extends Plugin {
	private totalNewEntries = 0;

	blacklistedURLs = ["www.theatlantic.com", "www.wsj.com", "arxiv.org"];
	blacklistedStrings = [" hiring "];

	async onload() {
		console.log("Read Later - Loaded");

		this.registerInterval(
			window.setInterval(() => this.run(), 300000) // 5 minutes in milliseconds
		);
	}

	onunload() {}

	async run() {
		const folder = this.app.vault.getFolderByPath("read later");
		if (!folder) {
			new Notice("Read Later - Folder does not exist");
			console.warn("Read Later - Folder does not exist");
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sync = (this.app as any)?.internalPlugins?.plugins?.sync
			?.instance;
		if (sync && sync.syncStatus?.toLowerCase() !== "fully synced") {
			return;
		}

		const now = new Date();

		for (const file of folder.children) {
			if (!(file instanceof TFile)) {
				continue;
			}

			const lastSynced = this.getSyncedTime(file);
			const nextSync = new Date(lastSynced.getTime() + 3600000); // 1 hour in milliseconds

			if (now.getTime() < nextSync.getTime()) {
				continue;
			}

			console.log(`Read Later - Syncing ${file.name}`);

			const feeds = this.getFeedURLs(file);
			if (!feeds) {
				continue;
			}

			for (const feed of feeds) {
				try {
					await this.fetchFeed(file, feed, lastSynced);
				} catch (error) {
					this.notifyError(
						`Read Later - Error processing ${file.name}`,
						error
					);
				}
			}

			await this.updateSyncedTime(file, now);
			await this.removeOldEntries(file, now);
		}

		if (this.totalNewEntries > 0) {
			new Notice(
				`Read Later - ${this.totalNewEntries} new entries added`
			);
		}
		this.totalNewEntries = 0;
	}

	private getSyncedTime(file: TFile): Date {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontMatterCache = cache?.frontmatter;

		if (!frontMatterCache?.xml_synced) {
			return new Date(Date.now() - 31556926000); // 1 year in milliseconds
		}

		return new Date(frontMatterCache.xml_synced);
	}

	private getFeedURLs(file: TFile): string[] | null {
		const metadata = this.app.metadataCache.getFileCache(file);
		return metadata?.frontmatter?.xml_feeds ?? null;
	}

	async fetchFeed(file: TFile, feedURL: string, lastSynced: Date) {
		const xml = await request(feedURL);
		if (!xml) {
			return;
		}

		const feed = extractFromXml(xml);
		if (!feed || !feed.entries) {
			return;
		}

		let site = "-";
		try {
			site = feed.link
				? new URL(feed.link).hostname
				: new URL(feedURL).hostname;
		} catch {
			site = new URL(feedURL).hostname;
		}
		const domain = site.replace(/^www\./, "");

		let content = await this.app.vault.read(file);
		let count = 0;
		for (const entry of feed.entries.reverse()) {
			const entryDate = new Date(entry.published ?? "");

			if (entryDate.getTime() < lastSynced.getTime()) {
				continue;
			}

			if (this.isBlacklisted(entry.link, entry.title)) {
				continue;
			}

			if (entry.link && content.contains(entry.link)) {
				continue;
			}

			count++;
			const title =
				entry.title && entry.title !== ""
					? entry.title
					: entryDate.toISOString().split("T")[0];
			const date = ` ➕ ${entryDate.toISOString().split("T")[0]}`;
			const newEntry = `\n- [ ] [${title}](${entry.link}) [site:: ${domain}]${date}\n`;
			content = content.trimEnd() + newEntry;
		}

		if (count > 0) {
			this.totalNewEntries += count;
		}

		await this.app.vault.modify(file, content);
	}

	async updateSyncedTime(file: TFile, currentTime: Date) {
		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontMatter) =>
					(frontMatter.xml_synced = currentTime.toISOString())
			);
		} catch (error) {
			this.notifyError(
				`Read Later - Failed to update timestamp in ${file.path}`,
				error
			);
			return { status: "error", error };
		}
	}

	async removeOldEntries(file: TFile, currentTime: Date) {
		const currentDate = currentTime.toISOString().split("T")[0];
		const content = await this.app.vault.read(file);
		const entries = content.split("\n");

		const cleanedEntries = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (
				!entry.startsWith("- [x]") ||
				entry.includes(`✅ ${currentDate}`)
			) {
				cleanedEntries.push(entry);
			}
		}

		const cleanedContent = cleanedEntries.join("\n");
		if (cleanedContent === content) {
			return;
		}

		await this.app.vault.modify(file, cleanedContent);
	}

	private isBlacklisted(
		url: string | undefined,
		title: string | undefined
	): boolean {
		if (
			url &&
			this.blacklistedURLs.some((blacklisted) =>
				url.toLowerCase().includes(blacklisted)
			)
		) {
			return true;
		}

		if (
			title &&
			this.blacklistedStrings.some((blacklisted) =>
				title.toLowerCase().includes(blacklisted)
			)
		) {
			return true;
		}

		return false;
	}

	private notifyError(message: string, error: Error) {
		const errorMessage = `${message}: ${error.message}`;
		new Notice(errorMessage, 4000);
		console.error(errorMessage);
	}
}
