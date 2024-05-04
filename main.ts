import { Notice, Plugin, TFile, request } from "obsidian";
import { extractFromXml } from "@extractus/feed-extractor";

type Entry = {
	domain: string;
	link: string;
	title: string;
	date: Date;
};

export default class ReadLaterPlugin extends Plugin {
	private totalNewEntries = 0;

	blacklistedURLs = ["www.theatlantic.com", "www.wsj.com", "arxiv.org"];
	blacklistedStrings = ["hiring"];

	async onload() {
		console.log("Read Later - Loaded");

		this.registerInterval(
			window.setInterval(() => this.run(), 5 * 60 * 1000) // 5 minutes in milliseconds
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

			// 1. Fetch synced datetime
			const lastSynced = this.getSyncedTime(file);
			const nextSync = new Date(lastSynced.getTime() + 60 * 60 * 1000); // 1 hour in milliseconds

			if (now.getTime() < nextSync.getTime()) {
				continue;
			}

			console.log(`Read Later - Syncing ${file.name}`);

			// 2. Fetch feeds
			const feeds = this.getFeedURLs(file);
			if (!feeds) {
				continue;
			}

			const entries: Entry[] = [];
			for (const feed of feeds) {
				try {
					// 3. Fetch new entries from feeds, skip blacklisted entries
					entries.push(
						...(await this.fetchFeedEntries(feed, lastSynced))
					);
				} catch (error) {
					// 4. Log and ignore failed feeds
					this.notifyError(
						`Read Later - Error fetching feeds from ${feed}`,
						error
					);
				}
			}

			// 5. Load category content
			const content = await this.app.vault.read(file);

			// 6. Add new entries to content
			const mergedContent = this.mergeEntriesWithContent(
				entries,
				content
			);

			// 7. Remove old entries from content
			const cleanedContent = this.removeOldEntries(mergedContent, now);

			if (content !== cleanedContent) {
				// 8. Save new category content if there are changes
				await this.app.vault.modify(file, cleanedContent);
			}

			// 9. Update synced datetime
			await this.updateSyncedTime(file, now);
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

		if (!frontMatterCache?.readlater_synced) {
			return new Date(Date.now() - 1 * 365 * 24 * 60 * 60 * 1000); // 1 year in milliseconds
		}

		return new Date(frontMatterCache.readlater_synced);
	}

	private getFeedURLs(file: TFile): string[] | null {
		const metadata = this.app.metadataCache.getFileCache(file);
		return metadata?.frontmatter?.readlater_feeds ?? null;
	}

	async fetchFeedEntries(
		feedURL: string,
		lastSynced: Date
	): Promise<Entry[]> {
		const entries: Entry[] = [];
		const xml = await request(feedURL);
		if (!xml) {
			return entries;
		}

		const feed = extractFromXml(xml);
		if (!feed || !feed.entries) {
			return entries;
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

		for (const entry of feed.entries) {
			const entryDate = new Date(entry.published ?? "");

			if (entryDate.getTime() < lastSynced.getTime()) {
				continue;
			}

			if (this.isBlacklisted(entry.link, entry.title)) {
				continue;
			}

			entries.push({
				domain: domain,
				link: entry.link ?? "",
				title: entry.title ?? "",
				date: entryDate,
			});
		}

		return entries;
	}

	private mergeEntriesWithContent(entries: Entry[], content: string): string {
		let count = 0;
		for (const entry of entries.reverse()) {
			if (content.contains(entry.link)) {
				continue;
			}

			count++;
			const title =
				entry.title !== ""
					? entry.title
					: entry.date.toISOString().split("T")[0];
			const date = ` ➕ ${entry.date.toISOString().split("T")[0]}`;
			const newEntry = `\n- [ ] [${title}](${entry.link}) [site:: ${entry.domain}]${date}\n`;

			content = content.trimEnd() + newEntry;
		}

		if (count > 0) {
			this.totalNewEntries += count;
		}

		return content;
	}

	async updateSyncedTime(file: TFile, currentTime: Date) {
		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontMatter) => {
					frontMatter.readlater_synced = currentTime.getTime();
				}
			);
		} catch (error) {
			this.notifyError(
				`Read Later - Failed to update timestamp in ${file.path}`,
				error
			);
			return { status: "error", error };
		}
	}

	private removeOldEntries(content: string, currentTime: Date): string {
		const currentDate = currentTime.toISOString().split("T")[0];
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

		return cleanedEntries.join("\n");
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
