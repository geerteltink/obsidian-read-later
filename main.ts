import { Notice, Plugin, TFile } from "obsidian";
import Parser from "rss-parser";

export default class ReadLaterPlugin extends Plugin {
	async onload() {
		console.log("Read Later - Loaded");

		// This function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(
			window.setInterval(() => this.run(), 10 * 60 * 1000)
		);
	}

	onunload() {}

	async run() {
		const folder = this.app.vault.getFolderByPath("read later");
		if (folder === null) {
			console.warn("Read Later - Folder does not exist");
			return;
		}

		const now = new Date();

		for (const file of folder.children) {
			if (file instanceof TFile) {
				const lastSynced = this.extractSyncedTime(file);

				const nextSync = new Date(lastSynced);
				nextSync.setHours(nextSync.getHours() + 1);

				if (now.getTime() < nextSync.getTime()) {
					return;
				}

				const feeds = this.extractFeeds(file);
				if (feeds === null) {
					return;
				}

				for (const feed of feeds) {
					await this.updateFeed(file, feed, lastSynced);
					await this.updateSyncedTime(file, now);
				}
			}
		}
	}

	extractSyncedTime(file: TFile): Date {
		const metadataCache = this.app.metadataCache.getFileCache(file);
		const frontMatterCache = metadataCache?.frontmatter;

		if (frontMatterCache === undefined || !frontMatterCache.xml_synced) {
			const defaultDate = new Date();
			defaultDate.setFullYear(new Date().getFullYear() - 3);

			return defaultDate;
		}

		return new Date(frontMatterCache.xml_synced);
	}

	extractFeeds(file: TFile): string[] | null {
		const metadataCache = this.app.metadataCache.getFileCache(file);
		const frontMatterCache = metadataCache?.frontmatter;

		if (frontMatterCache === undefined) {
			return null;
		}

		return frontMatterCache.xml_feeds;
	}

	async updateFeed(file: TFile, url: string, lastSynced: Date) {
		let content = await this.app.vault.read(file);
		const parser = new Parser({
			defaultRSS: 2.0,
			timeout: 10000,
		});

		try {
			const feed = await parser.parseURL(url);

			const site = feed.link
				? new URL(feed.link).hostname
				: feed.title ?? "-";
			const domain = site.replace(/^www\./, "");

			for (const entry of feed.items.reverse()) {
				const entryCreated = new Date(entry.isoDate ?? "");

				// Skip old entries
				if (entryCreated.getTime() < lastSynced.getTime()) {
					continue;
				}

				// Skip duplicate entries
				if (entry.link && content.contains(entry.link)) {
					continue;
				}

				const date = entry.isoDate
					? ` ➕ ${entry.isoDate.split("T")[0]}`
					: "";

				content.trimEnd();
				content += `- [ ] [${entry.title}](${entry.link}) [site:: ${domain}]${date}\n`;
			}
		} catch (error) {
			return;
		}

		await this.app.vault.modify(file, content);
	}

	async updateSyncedTime(file: TFile, now: Date) {
		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					frontmatter["xml_synced"] = now.toISOString();
				}
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			if (e?.name === "YAMLParseError") {
				const errorMessage = `Timestamp failed to update because of malformed frontmatter on this file : ${file.path} ${e.message}`;
				new Notice(errorMessage, 4000);
				console.error(errorMessage);
				return {
					status: "error",
					error: e,
				};
			}
		}
	}
}
