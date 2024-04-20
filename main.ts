import { Notice, Plugin, TFile } from "obsidian";
import Parser from "rss-parser";

export default class ReadLaterPlugin extends Plugin {
	private totalNewEntries = 0;

	async onload() {
		console.log("Read Later - Loaded");

		// This function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(
			window.setInterval(() => this.run(), 5 * 60 * 1000)
		);
	}

	onunload() {}

	async run() {
		const folder = this.app.vault.getFolderByPath("read later");
		if (!folder) {
			console.warn("Read Later - Folder does not exist");
			return;
		}

		const now = new Date();

		for (const file of folder.children) {
			if (!(file instanceof TFile)) {
				continue;
			}

			const lastSynced = this.getSyncedTime(file);
			const nextSync = new Date(lastSynced);
			nextSync.setHours(nextSync.getHours() + 1);

			if (now.getTime() < nextSync.getTime()) {
				continue;
			}

			const feeds = this.getFeedURLs(file);
			if (!feeds) {
				continue;
			}

			for (const feed of feeds) {
				try {
					await this.fetchFeed(file, feed, lastSynced);
					await this.updateSyncedTime(file, now);
					await this.removeOldEntries(file, now);
				} catch (error) {
					this.notifyError(
						`Read Later - Error processing ${file.name}`,
						error
					);
				}
			}
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
			return new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000); // 3 years ago
		}

		return new Date(frontMatterCache.xml_synced);
	}

	private getFeedURLs(file: TFile): string[] | null {
		const metadata = this.app.metadataCache.getFileCache(file);
		return metadata?.frontmatter?.xml_feeds ?? null;
	}

	async fetchFeed(file: TFile, feedURL: string, lastSynced: Date) {
		let content = await this.app.vault.read(file);
		const parser = new Parser({ defaultRSS: 2.0, timeout: 10000 });
		const feed = await parser.parseURL(feedURL);

		let site = "-";
		try {
			site = feed.link
				? new URL(feed.link).hostname
				: new URL(feedURL).hostname;
		} catch {
			site = new URL(feedURL).hostname;
		}
		const domain = site.replace(/^www\./, "");

		let count = 0;
		for (const entry of feed.items.reverse()) {
			const entryDate = new Date(entry.isoDate ?? "");

			if (entryDate.getTime() < lastSynced.getTime()) {
				continue;
			}

			if (entry.link && content.contains(entry.link)) {
				continue;
			}

			count++;
			const date = entry.isoDate
				? ` ➕ ${entry.isoDate.split("T")[0]}`
				: "";
			const newEntry = `\n- [ ] [${entry.title}](${entry.link}) [site:: ${domain}]${date}\n`;
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

	private notifyError(message: string, error: Error) {
		const errorMessage = `${message}: ${error.message}`;
		new Notice(errorMessage, 4000);
		console.error(errorMessage);
	}
}
