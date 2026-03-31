import { Tool } from ".";
import { ICompanyRepository } from "../repositories/companyRepository/interfaces/ICompanyRepository";
import { IEmbeddingProvider } from "../providers/EmbeddingProvider/interfaces/IEmbeddingProvider";

export class FindCompanyInfoTool extends Tool {
  private repository: ICompanyRepository;
  private embedding: IEmbeddingProvider;

  private constructor(
    repository: ICompanyRepository,
    embedding: IEmbeddingProvider,
  ) {
    super({
      name: "findCompanyInfo",
      description:
        "Ferramenta para buscar informações sobre a empresa como nome, endereço, telefone, horário de funcionamento, formas de pagamento, política de entrega e outras informações institucionais.",
    });

    this.repository = repository;
    this.embedding = embedding;

    this.addParameter({
      name: "query",
      type: "string",
      description: "Informação sobre a empresa que deseja buscar",
      required: true,
    });
  }

  public static create(
    repository: ICompanyRepository,
    embedding: IEmbeddingProvider,
  ): FindCompanyInfoTool {
    return new FindCompanyInfoTool(repository, embedding);
  }

  public async execute({ query }: { query: string }) {
    const vector = await this.embedding.embed({ text: query });
    return this.repository.search({ vector });
  }
}
