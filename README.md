# Productboard Agent

A product management agent that integrates with Productboard's API for accessing product data, features, releases, and customer insights.

## Tools

- `pb_list_products` - List all products in the Productboard workspace
- `pb_get_product` - Get detailed information about a specific product
- `pb_list_features` - List features with filtering by product, status, and release
- `pb_get_feature` - Get detailed information about a specific feature
- `pb_list_releases` - List product releases with timeline information
- `pb_get_release` - Get detailed information about a specific release
- `pb_list_statuses` - List all available feature statuses
- `pb_list_objectives` - List product objectives and key results
- `pb_list_companies` - List companies with customer feedback data
- `current_date` - Get current date and time with quarter calculations

## Core Capabilities

### Product Data Access
- Productboard REST API v1 integration with Bearer token authentication
- Access to products, features, releases, objectives, and customer data
- Automatic UUID-to-name conversion for readable output
- Cursor-based pagination for large datasets

### Feature Management
- Feature lifecycle tracking with status monitoring
- Release assignment and timeline management
- Priority and effort estimation data
- Custom field access for extended metadata

### Customer Intelligence
- Company and customer feedback data
- User insight tracking and analysis
- Feature request correlation with customer data
- Feedback sentiment and priority information

### Date and Time Context
- Quarter-aware planning with automatic date resolution
- Roadmap timeline calculations
- Support for relative time queries ("next quarter", "upcoming")

### Platform Integration
- Native Slack integration with emoji reactions and threading
- Multi-platform support for Slack channels and web interfaces
- Real-time status updates during API operations

## Use Cases

- Product roadmap planning and analysis
- Feature prioritization and status tracking
- Customer feedback analysis
- Release planning and milestone management
- Stakeholder reporting and communication
- Competitive analysis and market research

## Technical Details

- **API**: Productboard REST API v1 with Bearer authentication
- **Error Handling**: Retry logic with exponential backoff (3 attempts, 250ms base delay)
- **Data Processing**: Automatic UUID conversion to human-readable names
- **Default Scope**: "coder" product with flexible multi-product support
- **Pagination**: Cursor-based pagination with configurable limits